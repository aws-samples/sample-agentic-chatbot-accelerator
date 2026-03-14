# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import os
from typing import Dict, List

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

AWS_REGION = os.environ["AWS_REGION"]
SESSIONS_TABLE_NAME = os.environ.get("SESSIONS_TABLE_NAME", "Table???")
SESSIONS_BY_USER_ID_INDEX_NAME = os.environ.get("SESSIONS_BY_USER_ID_INDEX_NAME", "???")


dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(SESSIONS_TABLE_NAME)  # type: ignore
logger = Logger()


def get_session(session_id: str, user_id: str) -> Dict:
    """
    Retrieves a session record from DynamoDB using the session ID and user ID.

    Args:
        session_id (str): The unique identifier for the session
        user_id (str): The unique identifier for the user

    Returns:
        Dict: The session record if found, empty dict if not found or error occurs

    Raises:
        ClientError: If there is an error communicating with DynamoDB
    """
    response = {}
    try:
        response = table.get_item(Key={"SessionId": session_id, "UserId": user_id})
    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning("No record found with session id: %s", session_id)
        else:
            logger.exception(error)

    return response.get("Item", {})


def list_sessions_by_user_id(user_id: str) -> List:
    """
    Retrieves all session records for a given user ID from DynamoDB using a secondary index.

    Args:
        user_id (str): The unique identifier for the user

    Returns:
        List: A list of session records associated with the user ID. Returns empty list if no records found or error occurs.

    Raises:
        ClientError: If there is an error communicating with DynamoDB
    """
    items = []
    try:
        last_evaluated_key = None
        while True:
            if last_evaluated_key:
                response = table.query(
                    KeyConditionExpression="UserId = :user_id",
                    ExpressionAttributeValues={":user_id": user_id},
                    IndexName=SESSIONS_BY_USER_ID_INDEX_NAME,
                    ExclusiveStartKey=last_evaluated_key,
                )
            else:
                response = table.query(
                    KeyConditionExpression="UserId = :user_id",
                    ExpressionAttributeValues={":user_id": user_id},
                    IndexName=SESSIONS_BY_USER_ID_INDEX_NAME,
                )

            items.extend(response.get("Items", []))

            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break

    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning("No record found for user id: %s", user_id)
        else:
            logger.exception(error)

    return items


def delete_session(session_id: str, user_id: str) -> Dict:
    """
    Deletes a session record from DynamoDB using the session ID and user ID.

    Args:
        session_id (str): The unique identifier for the session
        user_id (str): The unique identifier for the user

    Returns:
        Dict: A dictionary containing:
            - id (str): The session ID that was requested to be deleted
            - deleted (bool): True if deletion was successful, False otherwise

    Raises:
        ClientError: If there is an error communicating with DynamoDB
    """
    try:
        table.delete_item(Key={"SessionId": session_id, "UserId": user_id})
    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning("No record found with session id: %s", session_id)
        else:
            logger.exception(error)

        return {"id": session_id, "deleted": False}

    return {"id": session_id, "deleted": True}


def delete_user_sessions(user_id: str) -> List:
    """
    Deletes all session records associated with a given user ID from DynamoDB.

    Args:
        user_id (str): The unique identifier for the user

    Returns:
        List: A list of dictionaries containing:
            - id (str): The session ID that was requested to be deleted
            - deleted (bool): True if deletion was successful, False otherwise

    Raises:
        ClientError: If there is an error communicating with DynamoDB
    """
    sessions = list_sessions_by_user_id(user_id)
    ret_value = []

    for session in sessions:
        try:
            result = delete_session(session["SessionId"], user_id)
        except ClientError as error:
            if error.response["Error"]["Code"] == "ResourceNotFoundException":
                logger.warning(
                    f"No record found with session id: {session} for user {user_id}"
                )
            else:
                logger.exception(error)
        ret_value.append({"id": session["SessionId"], "deleted": result["deleted"]})

    return ret_value


def rename_session(user_id: str, session_id: str, title: str) -> bool:
    """
    Renames a session for a given user.

    Args:
        user_id (str): The unique identifier for the user
        session_id: The identifier of the session to be renamed

    Returns:
        bool: True if the session was successfully renamed, False otherwise
    """
    try:
        table.update_item(
            Key={"SessionId": session_id, "UserId": user_id},
            UpdateExpression="SET #name = :new_name",
            ExpressionAttributeNames={"#name": "Title"},
            ExpressionAttributeValues={":new_name": title},
        )
        return True
    except ClientError as error:
        logger.exception(error)
        return False


def update_message_execution_time(
    user_id: str, session_id: str, message_id: str, execution_time_ms: int
) -> bool:
    """
    Updates the execution time for a specific message in a session's history.

    Args:
        user_id (str): The unique identifier for the user
        session_id (str): The unique identifier for the session
        message_id (str): The unique identifier for the message to update
        execution_time_ms (int): The execution time in milliseconds

    Returns:
        bool: True if the message was successfully updated, False otherwise
    """
    try:
        # First, get the session to find the message index
        session = get_session(session_id, user_id)
        if not session or "History" not in session:
            logger.warning(f"Session {session_id} not found for user {user_id}")
            return False

        # Find the index of the message in the History array
        message_index = None
        for idx, item in enumerate(session["History"]):
            if item.get("type") != "assistant":
                continue
            if item.get("messageId") == message_id:
                message_index = idx
                break

        if message_index is None:
            logger.warning(f"Message {message_id} not found in session {session_id}")
            return False

        # Update the specific message with execution time
        table.update_item(
            Key={"SessionId": session_id, "UserId": user_id},
            UpdateExpression=f"SET History[{message_index}].#data.executionTimeMs = :exec_time",
            ExpressionAttributeNames={"#data": "data"},
            ExpressionAttributeValues={":exec_time": execution_time_ms},
        )

        logger.info(
            f"Updated execution time for message {message_id} in session {session_id}"
        )
        return True

    except ClientError as error:
        logger.exception(error)
        return False


def save_tool_actions(
    user_id: str, session_id: str, message_id: str, tool_actions: str
) -> bool:
    """
    Saves tool actions for a specific message in a session's history.

    Args:
        user_id (str): The unique identifier for the user
        session_id (str): The unique identifier for the session
        message_id (str): The unique identifier for the message to update
        tool_actions (str): JSON string containing the tool actions array

    Returns:
        bool: True if the tool actions were successfully saved, False otherwise
    """
    try:
        # First, get the session to find the message index
        session = get_session(session_id, user_id)
        if not session or "History" not in session:
            logger.warning(f"Session {session_id} not found for user {user_id}")
            return False

        # Find the index of the message in the History array
        message_index = None
        for idx, item in enumerate(session["History"]):
            if item.get("type") != "assistant":
                continue
            if item.get("messageId") == message_id:
                message_index = idx
                break

        if message_index is None:
            logger.warning(f"Message {message_id} not found in session {session_id}")
            return False

        # Parse tool actions JSON to store as list in DynamoDB
        tool_actions_list = json.loads(tool_actions)

        # Update the specific message with tool actions
        table.update_item(
            Key={"SessionId": session_id, "UserId": user_id},
            UpdateExpression=f"SET History[{message_index}].#data.toolActions = :tool_actions",
            ExpressionAttributeNames={"#data": "data"},
            ExpressionAttributeValues={":tool_actions": tool_actions_list},
        )

        logger.info(
            f"Saved tool actions for message {message_id} in session {session_id}"
        )
        return True

    except ClientError as error:
        logger.exception(error)
        return False
    except json.JSONDecodeError as error:
        logger.error(f"Invalid JSON for tool_actions: {error}")
        return False
