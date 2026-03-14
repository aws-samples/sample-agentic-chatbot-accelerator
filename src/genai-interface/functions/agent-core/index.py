# -----------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -----------------------------------------------------------------------
from __future__ import annotations

import codecs
import json
import os
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional, Tuple

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import SNSEvent, event_source
from aws_lambda_powertools.utilities.parser import BaseModel
from botocore.exceptions import ClientError
from genai_core.api_helper.message_handler import send_to_client
from genai_core.api_helper.types import ChatbotAction
from genai_core.data.dynamo import ChatHistoryHandler
from genai_core.exceptions import AcaException
from genai_core.types import ChatbotMessage, EFramework, ERole
from pydantic import ValidationError

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.data_classes.sns_event import SNSEventRecord
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------------- Lambda Powertools ----------------------- #
logger = Logger(service="aca-agentCoreInterface")
tracer = Tracer(service="aca-agentCoreInterface")
# ------------------------------------------------------------------- #

# ---------------------- Environment Variables ---------------------- #
SESSION_TABLE = os.environ["SESSIONS_TABLE_NAME"]
ERROR_MESSAGE = os.environ.get(
    "DEFAULT_ERROR_MESSAGE",
    "Something went wrong! Try to initialize a new session and give it another try in a few seconds.",
)
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
# ------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
AC_CLIENT = boto3.client("bedrock-agentcore")
ACR_CLIENT = boto3.client("bedrock-agentcore-control")
# -------------------------------------------------------------------- #


class CallArguments(BaseModel):
    sessionId: str
    messageId: Optional[str] = None
    text: Optional[str] = None
    agentRuntimeId: Optional[str] = None
    qualifier: Optional[str] = None


class InputModel(BaseModel):
    userId: str
    action: ChatbotAction
    data: CallArguments
    framework: EFramework


@tracer.capture_method
def load_record(record: SNSEventRecord) -> InputModel:
    """Parse and validate SNS record message into InputModel.

    Args:
        record (SNSEventRecord): SNS event record containing message data

    Returns:
        InputModel: Validated input model with user action and data
    """
    message = record.sns.message
    logger.info("SNS Message", extra={"snsMessage": message})
    payload = InputModel.model_validate_json(message)
    logger.info("Parsed message content", extra={"payload": payload.model_dump()})
    return payload


@tracer.capture_method
def handle_heartbeat(record: InputModel) -> None:
    """Send heartbeat response to client.

    Args:
        record (InputModel): Input model containing session and user data
    """
    if record.data.agentRuntimeId and record.data.qualifier:
        logger.info("Sending heartbeat to AC runtime for warming up the session")
        try:
            payload = json.dumps(
                {
                    "isHeartbeat": True,
                    "userId": record.userId,
                }
            ).encode()

            AC_CLIENT.invoke_agent_runtime(
                agentRuntimeArn=record.data.agentRuntimeId,
                runtimeSessionId=record.data.sessionId,
                runtimeUserId=record.userId,
                payload=payload,
                qualifier=record.data.qualifier,
                accountId=ACCOUNT_ID,
            )
        except ClientError as _:
            logger.warning("Heartbeat silently failed")

    send_to_client(
        {
            "type": "text",
            "action": record.action.value,
            "direction": "OUT",
            "userId": record.userId,
            "framework": record.framework.value,
            "data": {
                "sessionId": record.data.sessionId,
            },
        }
    )


@tracer.capture_method
def handle_run(record: InputModel) -> None:
    """Execute agent runtime with user prompt and stream response.

    Args:
        record (InputModel): Input model containing user prompt and agent configuration

    Raises:
        AcaException: When prompt is missing
        AcaException: When agent runtime ID is missing
        AcaException: When qualifier/endpoint name is missing
        AcaException: When agent invocation fails
    """
    if record.data.text is None:
        err_msg = "Run request must contain a prompt"
        logger.error(err_msg)
        raise AcaException(err_msg)

    if record.data.agentRuntimeId is None:
        err_msg = "Run request must contain the runtime ID of the agent to be used"
        logger.error(err_msg)
        raise AcaException(err_msg)

    if record.data.qualifier is None:
        err_msg = "Run request must contain the name of the endpoint to be used"
        logger.error(err_msg)
        raise AcaException(err_msg)

    logger.info(
        "User added a message to a chatbot session",
        extra={
            "event": {
                "user": record.userId,
                "session": record.data.sessionId,
                "prompt": record.data.text,
            }
        },
    )

    runtime_version = ACR_CLIENT.get_agent_runtime_endpoint(
        agentRuntimeId=record.data.agentRuntimeId,
        endpointName=record.data.qualifier,
    ).get("liveVersion", "??")

    logger.info(
        "Agent Configuration",
        extra={
            "agentConfig": {
                "runtimeId": record.data.agentRuntimeId,
                "runtimeVersion": runtime_version,
                "qualifier": record.data.qualifier,
            }
        },
    )
    try:
        payload = json.dumps(
            {
                "prompt": record.data.text,
                "userId": record.userId,
                "messageId": record.data.messageId,
            }
        ).encode()

        response = AC_CLIENT.invoke_agent_runtime(
            agentRuntimeArn=record.data.agentRuntimeId,
            runtimeSessionId=record.data.sessionId,
            runtimeUserId=record.userId,
            payload=payload,
            qualifier=record.data.qualifier,
            accountId=ACCOUNT_ID,
        )

        # Use incremental decoder to handle UTF-8 characters split across chunk boundaries
        utf8_decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        buffer = ""
        response_data = dict()
        for chunk in response.get("response", []):
            # final=False allows incomplete UTF-8 sequences at end of chunk
            decoded_text = utf8_decoder.decode(chunk, final=False)
            events, buffer = parse_events(buffer + decoded_text)
            logger.debug(f"Events: {events}")
            for event in events:
                if event.get("action") == "final_response":
                    response_data = event.get("data", {})
                    logger.info(
                        "The agent returned a final response", extra={"event": event}
                    )
                elif event.get("error"):
                    logger.error(event["error"])
                    raise AcaException(event["error"])
                else:
                    logger.debug("Parsed event", extra={"event": event})
                send_to_client(event)

        # Flush any remaining bytes from the decoder
        final_text = utf8_decoder.decode(b"", final=True)
        if final_text:
            events, buffer = parse_events(buffer + final_text)
            for event in events:
                if event.get("action") == "final_response":
                    response_data = event.get("data", {})
                    logger.info(
                        "The agent returned a final response", extra={"event": event}
                    )
                elif event.get("error"):
                    logger.error(event["error"])
                    raise AcaException(event["error"])
                else:
                    logger.debug("Parsed event", extra={"event": event})
                send_to_client(event)
    except ClientError as err:
        err_msg = "Failed to invoke agent with AgentCore Runtime"
        logger.error(
            err_msg,
            extra={"rawErrorMessage": str(err)},
        )
        raise AcaException(err_msg) from err

    save_conversation_exchange(
        record=record,
        ai_response=response_data.get("content", ""),
        reasoning_content=response_data.get("reasoningContent", ""),
        references=response_data.get("references"),
        runtime_id=record.data.agentRuntimeId,
        runtime_version=runtime_version,
        endpoint_name=record.data.qualifier,
    )


@tracer.capture_method
def parse_events(stream: str) -> Tuple[list[dict], str]:
    """Parse events from stream and extract JSON events.

    Args:
        stream (str): Raw stream data

    Returns:
        Tuple[list[dict], str]: Parsed events and remaining unparsed data
    """
    parsed_events = []
    unparsed_data = stream

    while True:
        event_match = re.search(r"data: ({.*?})\n", unparsed_data)
        if not event_match:
            break
        try:
            parsed_events.append(json.loads(event_match.group(1)))
            unparsed_data = (
                unparsed_data[: event_match.start()]
                + unparsed_data[event_match.end() :]
            )
        except json.JSONDecodeError:
            break

    return parsed_events, unparsed_data


@tracer.capture_method
def save_conversation_exchange(
    ai_response: str,
    record: InputModel,
    reasoning_content: str,
    references: Optional[str],
    runtime_id: str,
    runtime_version: str,
    endpoint_name: str,
) -> None:
    """Save user prompt and AI response to chat history.

    Args:
        ai_response (str): AI-generated response content
        record (InputModel): Input model containing user data and prompt
        rationale (str): AI reasoning for the response
        references (Optional[str]): Source references used in response
        runtime_id (str): Agent runtime identifier
        runtime_version (str): Version of the agent runtime
        endpoint_name (str): Name of the agent endpoint

    Raises:
        AssertionError: When messageId or text is None
    """
    if record.data.messageId is None:
        raise AssertionError(
            "Method called from inside handle_run --> messageId cannot be None"
        )

    history_handler = ChatHistoryHandler(
        table_name=SESSION_TABLE,
        session_id=record.data.sessionId,
        user_id=record.userId,
        logger=logger,
    )
    if not record.data.text:
        raise AssertionError("record.data.text cannot be None at this stage")
    user_prompt = ChatbotMessage.init_from_string(
        messageId=record.data.messageId, message=record.data.text
    )
    assistant_response = ChatbotMessage.init_from_string(
        messageId=record.data.messageId, message=ai_response, role=ERole.ASSISTANT
    )
    history_handler.add_message_to_chat(
        message=user_prompt,
        render=True,
        runtime_id=runtime_id,
        runtime_version=runtime_version,
        endpoint_name=endpoint_name,
    )

    parsed_refs = json.loads(references) if references else None
    history_handler.add_message_to_chat(
        message=assistant_response,
        render=True,
        references=parsed_refs,
        reasoning_content=reasoning_content,
    )


@event_source(data_class=SNSEvent)
@tracer.capture_lambda_handler
def handler(event: SNSEvent, _: LambdaContext) -> dict:
    """Lambda handler for processing SNS events from chatbot interactions.

    Args:
        event (SNSEvent): SNS event containing chatbot action records
        _ (LambdaContext): Lambda context (unused)

    Returns:
        dict: Response with status code and number of processed records
    """
    logger.info(event)
    record_counter = 0

    for record in event.records:
        try:
            payload = load_record(record)

            if payload.action == ChatbotAction.RUN:
                handle_run(payload)
            elif payload.action == ChatbotAction.HEARTBEAT:
                handle_heartbeat(payload)
            else:
                send_to_client(
                    {
                        "action": "error",
                        "userId": payload.userId,
                        "timestamp": str(
                            int(round(datetime.now(timezone.utc).timestamp()))
                        ),
                        "type": "text",
                        "framework": EFramework.AGENT_CORE.value,
                        "data": {
                            "content": "Assertion error: unknown action.",
                            "sessionId": payload.data.sessionId,
                            "type": "text",
                        },
                    }
                )

        except ValidationError as err:
            logger.error(
                "Invalid SNS message format",
                extra={"originalErrorMessage": str(err)},
            )
            continue
        except AcaException as err:
            logger.exception(err)
            err_msg = (
                str(err) if err.get_error_number() in (8, 9, 10, 11) else ERROR_MESSAGE
            )
            err_msg = err_msg.split("]")[-1].strip()
            send_to_client(
                {
                    "action": "error",
                    "userId": payload.userId,
                    "timestamp": str(
                        int(round(datetime.now(timezone.utc).timestamp()))
                    ),
                    "type": "text",
                    "framework": EFramework.AGENT_CORE.value,
                    "data": {
                        "content": err_msg,
                        "sessionId": payload.data.sessionId,
                        "type": "text",
                    },
                }
            )
        except Exception as err:
            logger.exception(err)
            send_to_client(
                {
                    "action": "error",
                    "userId": payload.userId,
                    "timestamp": str(
                        int(round(datetime.now(timezone.utc).timestamp()))
                    ),
                    "type": "text",
                    "framework": EFramework.AGENT_CORE.value,
                    "data": {
                        "content": ERROR_MESSAGE,
                        "sessionId": payload.data.sessionId,
                        "type": "text",
                    },
                }
            )

        record_counter += 1

    logger.info(f"Processed {record_counter} SNS records")
    return {"status": 200, "body": {"numberRecords": record_counter}}
