# ----------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ----------------------------------------------------------------------
from __future__ import annotations

import json
from enum import Enum
from typing import Dict, List, Optional, Union

from pydantic import BaseModel, field_serializer

DEFAULT_ANSWER = "Sorry, something went wrong. Can you please reformulate your query?"


class EFramework(Enum):
    AGENT_CORE = "AGENT_CORE"


class ERole(Enum):
    """Defines the possible roles in a chatbot conversation.

    Attributes:
        ASSISTANT: Role representing the AI assistant/chatbot
        USER: Role representing the human user interacting with the chatbot
    """

    ASSISTANT = "assistant"
    USER = "user"


class EChatbotMode(Enum):
    """Defines the possible operating modes for a chatbot.

    Attributes:
        KB: Knowledge base mode where the chatbot uses a knowledge base to answer queries
        AGENT: Agent mode where the chatbot acts as an interactive agent with additional capabilities
    """

    KB = "knowledgebase"
    STRANDS_AGENT = "strandsAgent"


# ----------------------------------------------------------------------
class InferenceConfig(BaseModel):
    """Configuration for model inference parameters.

    Attributes:
        maxTokens (int): Maximum number of tokens to generate in the response
        temperature (float): Controls randomness in response generation. Higher values (e.g. 1.0) make output more random,
            lower values (e.g. 0.1) make it more focused and deterministic
        stopSequences (Optional[List[str]]): List of sequences that will stop text generation when encountered. Default None
    """

    maxTokens: int
    temperature: float
    stopSequences: Optional[List[str]] = None


class ChatbotMessage(BaseModel):
    """Represents a message in a chatbot conversation.

    Attributes:
        role (Role): The role of the entity sending the message.
            See `Role` for valid options.
        content (List[Dict[str, str]]): A list of dictionaries representing the content of the message.
            This format follows specifications of Bedrock Converse API.

    Examples:
        >>> message = ChatbotMessage(role=Role.USER, content=[{"text": "Hello, how are you?"}])
    """

    messageId: str
    role: ERole
    content: List[Dict[str, Union[str, Dict]]]

    @staticmethod
    def init_from_string(
        message: str, messageId: str, role: ERole = ERole.USER
    ) -> ChatbotMessage:
        return ChatbotMessage(
            messageId=messageId, role=role, content=[{"text": message}]
        )

    @field_serializer("role")
    def serialize_role(self, role: ERole):
        return role.value

    def get_message(self, default_answer: Optional[str] = None) -> str:
        if not self.content:
            return default_answer if default_answer else DEFAULT_ANSWER

        if "text" in self.content[0]:
            return self.content[0]["text"]  # type: ignore

        return json.dumps(self.content[0])
