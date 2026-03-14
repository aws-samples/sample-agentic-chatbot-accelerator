# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #

import json
from decimal import Decimal
from typing import Mapping

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from genai_core.api_helper import sessions as session_helper
from genai_core.api_helper.auth import fetch_user_id

tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-sessionsRoute")


@router.resolver(field_name="listSessions")
@tracer.capture_method
@fetch_user_id(router)
def get_sessions(user_id: str):
    sessions = session_helper.list_sessions_by_user_id(user_id)

    return [
        {
            "id": session.get("SessionId"),
            "title": _initialize_title(session),
            "startTime": f'{session.get("StartTime")}',
            "runtimeId": session.get("RuntimeId", ""),
            "runtimeVersion": session.get("RuntimeVersion", ""),
            "endpoint": session.get("Endpoint"),
        }
        for session in sessions
    ]


@router.resolver(field_name="getSession")
@tracer.capture_method
@fetch_user_id(router)
def get_session(user_id: str, id: str):
    session = session_helper.get_session(id, user_id)
    if not session:
        return None

    history = []
    for item in session.get("History", []):
        if item.get("render", False) is False:
            continue
        data = item.get("data", {})
        history_item = {
            "type": item.get("type"),
            "content": data.get("content"),
            "messageId": item.get("messageId"),
            "complete": True,  # Historical messages are always complete
        }
        if "references" in data:
            logger.info(data.get("references"))
            history_item["references"] = json.dumps(data.get("references"))
        if "feedback" in data:
            logger.info(data.get("feedback"))
            history_item["feedback"] = json.dumps(data.get("feedback"))
        if "reasoningContent" in data:
            history_item["reasoningContent"] = data["reasoningContent"]
        if "toolActions" in data:
            # Convert Decimal to int for JSON serialization
            tool_actions = data["toolActions"]
            for action in tool_actions:
                if "invocationNumber" in action and isinstance(
                    action["invocationNumber"], Decimal
                ):
                    action["invocationNumber"] = int(action["invocationNumber"])
            history_item["toolActions"] = json.dumps(tool_actions)
        if "executionTimeMs" in data:
            history_item["executionTimeMs"] = data["executionTimeMs"]
        history.append(history_item)

    return {
        "id": session.get("SessionId"),
        "title": _initialize_title(session),
        "startTime": f'{session.get("StartTime")}',
        "history": history,
        "runtimeId": session.get("RuntimeId", ""),
        "runtimeVersion": session.get("RuntimeVersion", ""),
        "endpoint": session.get("Endpoint"),
    }


def _initialize_title(session: Mapping) -> str:
    title = session.get("Title")
    if title:
        return title
    first_msg = (
        session.get("History", [{}])[0]
        .get("data", {})
        .get("content", "EMPTY CONVERSATION")
    )
    return first_msg


@router.resolver(field_name="deleteUserSessions")
@tracer.capture_method
@fetch_user_id(router)
def delete_user_sessions(user_id: str):
    return session_helper.delete_user_sessions(user_id)


@router.resolver(field_name="deleteSession")
@tracer.capture_method
@fetch_user_id(router)
def delete_session(user_id: str, id: str):
    return session_helper.delete_session(id, user_id)


@router.resolver(field_name="renameSession")
@tracer.capture_method
@fetch_user_id(router)
def rename_session(user_id: str, id: str, title: str) -> bool:
    return session_helper.rename_session(user_id, id, title)


@router.resolver(field_name="updateMessageExecutionTime")
@tracer.capture_method
@fetch_user_id(router)
def update_message_execution_time(
    user_id: str, sessionId: str, messageId: str, executionTimeMs: int
) -> bool:
    return session_helper.update_message_execution_time(
        user_id=user_id,
        session_id=sessionId,
        message_id=messageId,
        execution_time_ms=executionTimeMs,
    )


@router.resolver(field_name="saveToolActions")
@tracer.capture_method
@fetch_user_id(router)
def save_tool_actions(
    user_id: str, sessionId: str, messageId: str, toolActions: str
) -> bool:
    return session_helper.save_tool_actions(
        user_id=user_id,
        session_id=sessionId,
        message_id=messageId,
        tool_actions=toolActions,
    )
