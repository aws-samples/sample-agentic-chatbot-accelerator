# -----------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -----------------------------------------------------------------------
"""
Lambda handler for processing agent tools messages from SNS topic.
This is a placeholder implementation that logs the message content.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import SNSEvent, event_source
from botocore.exceptions import ClientError
from genai_core.api_helper.message_handler import send_to_client
from pydantic import BaseModel

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.data_classes.sns_event import SNSEventRecord
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------------- Lambda Powertools ----------------------- #
logger = Logger(service="aca-agentToolsHandler")
tracer = Tracer(service="aca-agentToolsHandler")
# ------------------------------------------------------------------- #
CLIENT = boto3.client("bedrock-runtime")

SYS_PROMPT = """You are a UI assistant that explains agent actions to non-technical users.

Given a JSON object describing a tool invocation, generate a brief, friendly one-sentence description of what the agent is doing.

Rules:
- Use simple, everyday language (no technical jargon)
- Keep it under 30 words
- Use present continuous tense ("Looking up...", "Retrieving...", "Checking...")
- Focus on the user benefit or action, not the technical details
- Include relevant parameter values when they add context (e.g., order numbers, names)
- Do not mention "tool", "API", "function", or "parameter"

Examples:
- Input: {"toolName": "get_order_tool", "toolDescription": "tool to get the order", "parameters": [{"name": "orderId", "value": "123"}]}
- Output: "Looking up order #123..."

- Input: {"toolName": "search_products", "toolDescription": "searches product catalog", "parameters": [{"name": "query", "value": "blue shoes"}]}
- Output: "Searching for blue shoes..."

- Input: {"toolName": "get_weather", "toolDescription": "retrieves weather data", "parameters": [{"name": "city", "value": "Paris"}]}
- Output: "Checking the weather in Paris..."

Respond with only the description text, nothing else.
"""
MODEL_ID = "mistral.ministral-3-8b-instruct"


class Parameter(BaseModel):
    name: str
    type: str
    description: str
    value: Any


class Context(BaseModel):
    userId: str
    sessionId: str
    invocationNumber: int


class Data(BaseModel):
    toolName: str
    toolDescription: str
    parameters: list[Parameter]


class MessageModel(BaseModel):
    context: Context
    data: Data


@tracer.capture_method
def load_record(record: SNSEventRecord) -> MessageModel:
    message_id = record.sns.message_id
    subject = record.sns.subject or "No subject"

    logger.info(
        "Processing SNS message",
        extra={"subject": subject, "messageId": message_id},
    )

    payload = MessageModel.model_validate_json(record.sns.message)
    logger.info(
        "Agent tools message content",
        extra={"message_content": payload.model_dump()},
    )
    return payload


@tracer.capture_method
def process_record(record: SNSEventRecord) -> None:
    """Process a single SNS record and log its content.

    Args:
        record (SNSEventRecord): SNS event record containing message data
    """
    # Try to parse message as JSON for better logging
    parsed_message = load_record(record)

    try:
        messages = [
            {
                "role": "user",
                "content": [{"text": parsed_message.data.model_dump_json()}],
            },
        ]
        response = CLIENT.converse(
            modelId=MODEL_ID,
            messages=messages,
            system=[{"text": SYS_PROMPT}],
            inferenceConfig={"maxTokens": 1024, "temperature": 0.2},
        )
        tool_action = response["output"]["message"]["content"][0]["text"]

        logger.info(
            "Tool action described", extra={"outMessage": {"description": tool_action}}
        )

        # Send tool action to UI via messagesTopic
        send_to_client(
            {
                "action": "tool_action",
                "direction": "OUT",
                "userId": parsed_message.context.userId,
                "framework": "AGENT_CORE",
                "data": {
                    "sessionId": parsed_message.context.sessionId,
                    "toolAction": tool_action,
                    "toolName": parsed_message.data.toolName,
                    "invocationNumber": parsed_message.context.invocationNumber,
                },
            }
        )
    except ClientError:
        logger.error("Bedrock call failed")
        raise


@event_source(data_class=SNSEvent)
@tracer.capture_lambda_handler
def handler(event: SNSEvent, _: LambdaContext) -> dict:
    """Lambda handler for processing SNS events from agent tools topic.

    Args:
        event (SNSEvent): SNS event containing agent tools action records
        _ (LambdaContext): Lambda context (unused)

    Returns:
        dict: Response with status code and number of processed records
    """
    logger.info("Received agent tools event")
    record_counter = 0

    for record in event.records:
        try:
            process_record(record)
            record_counter += 1
        except Exception as err:
            logger.exception(
                "Failed to process record",
                extra={"errorMessage": str(err)},
            )

    logger.info(f"Processed {record_counter} SNS records")
    return {"status": 200, "body": {"numberRecords": record_counter}}
