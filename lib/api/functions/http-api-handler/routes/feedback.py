# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import os
from enum import Enum
from typing import Optional

import boto3
import pydantic
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from botocore.exceptions import ClientError
from genai_core.api_helper.auth import fetch_user_id

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-feedbackRoute")
# -------------------------------------------------------------------- #

# ----------------------- Environment Variables ---------------------- #
SESSION_TABLE_NAME = os.environ["SESSIONS_TABLE_NAME"]
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
dynamodb = boto3.resource("dynamodb")
SESSION_TABLE = dynamodb.Table(SESSION_TABLE_NAME)


# -------------------------------------------------------------------- #


class SentimentType(str, Enum):
    POSITIVE = "like"
    NEGATIVE = "dislike"
    NEUTRAL = ""


class FeedbackType(pydantic.BaseModel):
    sentiment: Optional[str]
    notes: Optional[str]


@router.resolver(field_name="publishFeedback")
@tracer.capture_method
@fetch_user_id(router)
def publish_feedback(
    user_id: str, messageId: str, messageType: str, sessionId: str, feedback: str
) -> bool:
    """Creates a new configuration for a given user.

    Args:
        user_id (str): The ID of the user providing the feedback
        messageId (str): The target message ID (unique session&messageType-wise)
        messageType (str): The target message type: (e.g. "assistant" or "user")
        sessionId (str): The target session ID (unique)
        feedback (str): JSON string containing the feedback

    Returns:
        bool: True if feedback was published successfully, False otherwise

    Raises:
        ClientError: If there is an error accessing DynamoDB, logged as exception
        json.JSONDecodeError: If config_value is not valid JSON, logged as error
        pydantic.ValidationError: If config_value does not match required schema, logged as error
    """

    try:
        feedback_dict = json.loads(feedback)
        FeedbackType(**feedback_dict)
        logger.info("The feedback is valid because it was successfully parsed")

    except (json.JSONDecodeError, pydantic.ValidationError):
        logger.error("Invalid feedback")
        return False

    if not feedback_dict:
        logger.error("Invalid feedback")
        return False

    try:
        # Build update expression and expression attribute values
        update_expression_parts = []
        expression_attribute_values = {}

        for key, value in feedback_dict.items():
            update_expression_parts.append(f"{key} = :{key.replace('.', '_')}")
            expression_attribute_values[f":{key.replace('.', '_')}"] = value

        update_expression = "SET " + ", ".join(update_expression_parts)

        response = SESSION_TABLE.get_item(
            Key={"SessionId": sessionId, "UserId": user_id}
        )

        if "Item" not in response:
            logger.error(
                f"No item found with SessionId={sessionId} and UserId={user_id}"
            )
            return False

        history = response["Item"].get("History", [])
        matching_indexes = []

        for i, entry in enumerate(history):
            if entry.get("messageId") == messageId and entry.get("type") == messageType:
                matching_indexes.append(i)

        if not len(matching_indexes) == 1:
            logger.error(
                f"Found {len(matching_indexes)} messages found with messageId={messageId}"
            )
            return False

        idx = matching_indexes[0]
        entry = history[idx]

        if entry.get("data", {}).get("feedback", None):
            # Feedback exists, update its fields
            update_expressions = []
            expression_values = {}

            for feedback_key, feedback_value in feedback_dict.items():
                update_expressions.append(
                    f"History[{idx}].#d.feedback.{feedback_key} = :val_{feedback_key}"
                )
                expression_values[f":val_{feedback_key}"] = feedback_value

            update_expression = "SET " + ", ".join(update_expressions)

            SESSION_TABLE.update_item(
                Key={"SessionId": sessionId, "UserId": user_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values,
                ExpressionAttributeNames={"#d": "data"},
            )
        else:
            # Feedback doesn't exist, create it with all fields
            SESSION_TABLE.update_item(
                Key={"SessionId": sessionId, "UserId": user_id},
                UpdateExpression=f"SET History[{idx}].#d.feedback = :feedback",
                ExpressionAttributeValues={":feedback": feedback_dict},
                ExpressionAttributeNames={"#d": "data"},
            )
        return True
    except ClientError as error:
        logger.exception(error)
        return False
