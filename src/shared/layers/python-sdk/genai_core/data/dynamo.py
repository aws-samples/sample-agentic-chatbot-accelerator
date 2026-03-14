# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError
from genai_core.exceptions import ReadFromDynamoError, WriteToDynamoError
from genai_core.types import ChatbotMessage, EChatbotMode, ERole

if TYPE_CHECKING:
    from aws_lambda_powertools import Logger
    from genai_core.processing.types import DocumentProcessingState

DYNAMO_RESOURCE = boto3.resource("dynamodb")


class DocumentStore:
    """Manages document metadata storage and retrieval in DynamoDB.

    This class provides a data access layer for storing and managing document processing metadata in DynamoDB.
    It handles CRUD (Create, Read, Update, Delete) operations for document records, tracking attributes like:
    - Document ID and execution ID
    - S3 location (bucket and object key)
    - Processing status
    - Creation timestamp
    - Custom metadata fields

    The class uses boto3 to interact with DynamoDB and includes error handling for common DynamoDB operations.

    Attributes:
        _table: DynamoDB table resource for storing document metadata
        _logger: Logger instance for recording operations and errors

    """

    def __init__(self, table_name: str, logger: Logger):
        self._table = DYNAMO_RESOURCE.Table(table_name)  # type: ignore
        self._logger = logger

    def update_field(self, document_id: str, field_name: str, field_value: str) -> None:
        """Updates a single field in a document record.

        Args:
            document_id (str): Unique identifier of the document to update
            field_name (str): Name of the field/attribute to update
            field_value (str): New value to set for the field

        Returns:
            None: Returns None but updates the specified field in DynamoDB

        Raises:
            WriteToDynamoError: If DynamoDB operation fails
        """
        try:
            self._table.update_item(
                Key={"DocumentId": document_id},
                AttributeUpdates={field_name: {"Value": field_value, "Action": "PUT"}},
            )
        except ClientError as err:
            raise WriteToDynamoError(self._table.table_name) from err

    def update_doc_status(self, document_id, status: DocumentProcessingState) -> None:
        """Updates the processing status of a document.

        Args:
            document_id (str): Unique identifier of the document to update
            status (str): New status value to set for the document

        Returns:
            None: Returns None but updates the document status in DynamoDB

        Raises:
            WriteToDynamoError: If DynamoDB operation fails
        """
        try:
            self.update_field(document_id, "DocumentStatus", status.value)
        except ClientError as err:
            raise WriteToDynamoError(self._table.table_name) from err

    def get_document(self, document_id: str) -> Optional[Dict]:
        """Retrieves a document record from DynamoDB by its ID.

        Args:
            document_id (str): Unique identifier of the document to retrieve

        Returns:
            Optional[Dict]: Document record as a dictionary if found, None if not found

        Raises:
            ReadFromDynamoError: If DynamoDB operation fails
        """
        try:
            response = self._table.get_item(Key={"DocumentId": document_id})
        except ClientError as err:
            raise ReadFromDynamoError(self._table.table_name) from err

        return response.get("Item")


class ChatHistoryHandler:
    """Handles chat history storage and retrieval in DynamoDB.

    This class provides functionality to store chat messages, load chat history,
    and manage references from chat history in a DynamoDB table.

    Attributes:
        _table: DynamoDB table resource for storing chat history
        _session_id: Unique identifier for the chat session
        _user_id: Identifier of the user for the chat session
        _logger: Logger instance for recording operations
    """

    def __init__(self, table_name: str, session_id: str, user_id: str, logger: Logger):
        self._table = DYNAMO_RESOURCE.Table(table_name)  # type: ignore
        self._session_id = session_id
        self._user_id = user_id
        self._logger = logger

    def load_chat_history(self) -> Optional[List[ChatbotMessage]]:
        """Loads the complete chat history for the current session.

        Retrieves all chat messages for the current session from DynamoDB and converts
        them into ChatbotMessage objects. Messages are returned in chronological order
        based on when they were added to the history.

        Returns:
            Optional[List[ChatbotMessage]]: List of chat messages in chronological order,
                or None if no history exists for the session.
        """
        items = self._get_attributes()
        if items and "History" in items:
            return self._items_to_messages(items["History"])

        self._logger.info("Session has not conversation history yet.")
        return None

    def load_bedrock_session(self) -> Optional[str]:
        items = self._get_attributes()
        if items and "BedrockSessionId" in items:
            return items["BedrockSessionId"]

        self._logger.info("A new session ID will be created.")
        return None

    def load_references_from_history(self) -> Optional[Dict]:
        """Extracts and combines all references from AI messages in the chat history.

        Returns:
            Dict: Combined dictionary of all references from AI messages
        """
        items = self._get_attributes()
        if items is None:
            return None

        out = {}

        for item in items:
            refs = item.get("data", {}).get("references")
            if refs and item.get("type") == "assistant":
                out.update(refs)

        return out

    def add_message_to_chat(
        self,
        message: ChatbotMessage,
        render: bool,
        bedrock_session_id: Optional[str] = None,
        references: Optional[List[Dict]] = None,
        inferenceConfig: Optional[Dict] = None,
        configuration_name: Optional[str] = None,
        inference_config_as_str: Optional[str] = None,
        configuration_agent_mode: Optional[EChatbotMode] = None,
        runtime_id: Optional[str] = None,
        runtime_version: Optional[str] = None,
        endpoint_name: Optional[str] = None,
        reasoning_content: Optional[str] = None,
    ) -> None:
        """Adds a new message to the chat history.

        # TODO simplify this function after code cleanup

        Args:
            message (ChatbotMessage): The message to add to history
            render (bool): Whether the message should be rendered in the UI
            references (Optional[List[Dict]], optional): List of reference metadata. Defaults to None.
            inferenceConfig (Optional[Dict], optional): Configuration for inference. Defaults to None.

        Returns:
            None
        """
        message_data: dict[str, Any] = {"content": message.get_message()}
        if references:
            self._logger.debug(references)
            message_data["references"] = references
        if inferenceConfig:
            self._logger.debug(inferenceConfig)
            message_data["inferenceConfig"] = self._convert_floats_to_strings(
                inferenceConfig
            )
        if reasoning_content:
            message_data["reasoningContent"] = reasoning_content

        to_add = [
            {
                "data": message_data,
                "messageId": message.messageId,
                "type": message.role.value,
                "render": render,
            }
        ]

        try:
            self._table.update_item(
                Key={"SessionId": self._session_id, "UserId": self._user_id},
                UpdateExpression="SET History = list_append(History, :new_message)",
                ExpressionAttributeValues={":new_message": to_add},
            )
            self._logger.info(
                f"Message added to history to session {self._session_id} - user {self._user_id}"
            )
        except ClientError:
            new_item_attributes = {
                "SessionId": self._session_id,
                "UserId": self._user_id,
                "History": to_add,
                "StartTime": datetime.now(timezone.utc).isoformat(),
            }
            if bedrock_session_id:
                new_item_attributes["BedrockSessionId"] = bedrock_session_id
            if configuration_name:
                new_item_attributes["ConfigurationName"] = configuration_name
            if inference_config_as_str:
                new_item_attributes["ConfigurationValue"] = inference_config_as_str
            if configuration_agent_mode:
                new_item_attributes["ExecutionMode"] = configuration_agent_mode.value
            if runtime_id:
                new_item_attributes["RuntimeId"] = runtime_id
            if runtime_version:
                new_item_attributes["RuntimeVersion"] = runtime_version
            if endpoint_name:
                new_item_attributes["Endpoint"] = endpoint_name
            self._table.put_item(Item=new_item_attributes)
            self._logger.info(
                f"New chat history created for session {self._session_id} - user {self._user_id}"
            )

    def _get_attributes(self) -> Optional[dict]:
        response = None
        try:
            response = self._table.get_item(
                Key={"SessionId": self._session_id, "UserId": self._user_id}
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ResourceNotFoundException":
                self._logger.warning(
                    "No record found with session id: %s", self._session_id
                )
            else:
                self._logger.exception(error)

        return response["Item"] if response and "Item" in response else None

    @staticmethod
    def _items_to_messages(items: List) -> List[ChatbotMessage]:
        return [
            ChatbotMessage.init_from_string(
                messageId=item.get("data", {}).get("messageId", f"msg-{i}-orphan"),
                message=item.get("data", {}).get("content", "???"),
                role=ERole(item.get("type", "assistant")),
            )
            for i, item in enumerate(items)
        ]

    @classmethod
    def _convert_floats_to_strings(cls, data):
        def _format_special_fields(key, value):
            if isinstance(value, float):
                if key == "temperature":
                    return f"{value:.2f}"
            return cls._convert_floats_to_strings(value)

        if isinstance(data, dict):
            return {
                key: (
                    _format_special_fields(key, value)
                    if key in ["temperature"]
                    else cls._convert_floats_to_strings(value)
                )
                for key, value in data.items()
            }
        elif isinstance(data, list):
            return [cls._convert_floats_to_strings(item) for item in data]
        elif isinstance(data, float):
            return str(data)
        else:
            return data
