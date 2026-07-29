# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Container-side session history persistence.
# Saves conversation exchanges to DynamoDB in the same format as the
# Lambda-based ChatHistoryHandler, enabling session history to work
# with the direct WebSocket architecture.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

SESSIONS_TABLE_NAME = os.environ.get("sessionsTableName", "")
AWS_REGION = os.environ.get("AWS_REGION")

logger = logging.getLogger("agentcore.session_history")


def _get_dynamo_table():
    """Get or create the DynamoDB Table resource."""
    if not SESSIONS_TABLE_NAME:
        return None
    dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
    return dynamodb.Table(SESSIONS_TABLE_NAME)


def save_conversation_exchange(
    session_id: str,
    user_id: str,
    message_id: str,
    user_message: str,
    ai_response: str,
    references: Optional[str] = None,
    reasoning_content: Optional[str] = None,
    structured_output: Optional[str] = None,
    runtime_id: Optional[str] = None,
    runtime_version: Optional[str] = None,
    endpoint_name: Optional[str] = None,
) -> None:
    """Save a user prompt + AI response pair to session history in DynamoDB.

    Follows the same DynamoDB schema as the Lambda ChatHistoryHandler:
    - Key: {SessionId, UserId}
    - History: list of {type, data: {content, messageId, ...}, messageId, render}
    - On first message: creates new item with StartTime, RuntimeId, etc.
    - On subsequent messages: appends to History list

    Args:
        session_id: Chat session identifier
        user_id: User identifier
        message_id: Message identifier
        user_message: The user's input text
        ai_response: The agent's response text
        references: Optional JSON string of reference citations
        reasoning_content: Optional model reasoning text
        structured_output: Optional structured output JSON string
        runtime_id: Agent runtime identifier
        runtime_version: Version of the agent runtime
        endpoint_name: Name of the agent endpoint
    """
    table = _get_dynamo_table()
    if table is None:
        logger.warning("sessionsTableName not configured — skipping history save")
        return

    # Build user message item
    user_item = {
        "type": "user",
        "messageId": message_id,
        "render": True,
        "data": {"content": user_message},
    }

    # Build assistant message item
    assistant_data: dict = {"content": ai_response}
    if references:
        try:
            assistant_data["references"] = json.loads(references)
        except (json.JSONDecodeError, TypeError):
            pass
    if reasoning_content:
        assistant_data["reasoningContent"] = reasoning_content
    if structured_output:
        assistant_data["structuredOutput"] = structured_output

    assistant_item = {
        "type": "assistant",
        "messageId": message_id,
        "render": True,
        "data": assistant_data,
    }

    messages_to_add = [user_item, assistant_item]

    # Idempotent upsert: append to History, seeding an empty list on first write.
    # if_not_exists() makes this safe whether or not the item already exists, so
    # the first message of a new session no longer raises a ValidationException
    # (list_append on a missing attribute) and there's no create/append race.
    update_expr = (
        "SET History = list_append(if_not_exists(History, :empty), :new_messages), "
        "StartTime = if_not_exists(StartTime, :now)"
    )
    expr_values: dict = {
        ":empty": [],
        ":new_messages": messages_to_add,
        ":now": datetime.now(timezone.utc).isoformat(),
    }
    # Session metadata is only set on creation (if_not_exists), never overwritten.
    if runtime_id:
        update_expr += ", RuntimeId = if_not_exists(RuntimeId, :runtime_id)"
        expr_values[":runtime_id"] = runtime_id
    if runtime_version:
        update_expr += (
            ", RuntimeVersion = if_not_exists(RuntimeVersion, :runtime_version)"
        )
        expr_values[":runtime_version"] = runtime_version
    if endpoint_name:
        update_expr += ", Endpoint = if_not_exists(Endpoint, :endpoint)"
        expr_values[":endpoint"] = endpoint_name

    try:
        table.update_item(
            Key={"SessionId": session_id, "UserId": user_id},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
        )
        logger.info(
            f"Messages persisted to session {session_id}",
            extra={"messageId": message_id},
        )
    except ClientError:
        logger.exception(
            f"Failed to persist messages to session {session_id}",
            extra={"messageId": message_id},
        )
        raise
