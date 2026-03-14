# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from pydantic import BaseModel, model_validator

# Re-export shared types for backwards compatibility
from shared.kb_types import (
    BedrockRerankingConfiguration,
    Citation,
    EContentType,
    ELocationType,
    ERerankingMetadataSelectionMode,
    ERowType,
    ESearchType,
    ImplicitFilterConfiguration,
    Interval,
    KnowledgeBaseRetrievalConfiguration,
    MetadataAttribute,
    ReferenceContent,
    ReferenceLocation,
    RerankingConfiguration,
    RerankingFieldName,
    RerankingMetadataConfiguration,
    RerankingModelConfiguration,
    RerankingSelectiveModeConfiguration,
    RetrievalConfiguration,
    RetrievedReference,
    RowContent,
    TextResponsePart,
    TextResponsePartElement,
)
from shared.stream_types import (
    ChatbotAction,
    EConversationManagerType,
    EStreamEvent,
    InferenceConfig,
    ModelConfiguration,
    StrandToken,
    Token,
)

# ============================================================================ #
# Docker-specific types
# ============================================================================ #


class AgentConfiguration(BaseModel):
    """Configuration for a single agent in the docker implementation.

    Attributes:
        modelInferenceParameters (ModelConfiguration): Model and inference settings
        instructions (str): System prompt defining the agent's role and behavior
        tools (list[str]): List of tool names this agent can use
        toolParameters (dict[str, dict]): Parameters for each tool
        mcpServers (list[str]): List of MCP server names to connect
        conversationManager (EConversationManagerType): How to manage conversation history
    """

    modelInferenceParameters: ModelConfiguration
    instructions: str
    tools: list[str]
    toolParameters: dict[str, dict]
    mcpServers: list[str]
    conversationManager: EConversationManagerType = (
        EConversationManagerType.SLIDING_WINDOW
    )

    @model_validator(mode="after")
    def validate_tool_parameters(self):
        """Validates that tool parameters match the defined tools.

        Checks that:
        - All tool parameter keys correspond to defined tools
        - Sub-agent tools have required agentName and agentVersion parameters

        Returns:
            AgentConfiguration: The validated configuration object

        Raises:
            ValueError: If validation fails due to missing or invalid parameters
        """
        tool_names = {tool_name for tool_name in self.tools}
        invalid_keys = set(self.toolParameters.keys()) - tool_names
        if invalid_keys:
            raise ValueError(f"toolParameters keys {invalid_keys} not found in tools")

        return self


# Re-export everything for backwards compatibility
__all__ = [
    # Shared KB types
    "BedrockRerankingConfiguration",
    "Citation",
    "EContentType",
    "ELocationType",
    "ERerankingMetadataSelectionMode",
    "ERowType",
    "ESearchType",
    "ImplicitFilterConfiguration",
    "Interval",
    "KnowledgeBaseRetrievalConfiguration",
    "MetadataAttribute",
    "ReferenceContent",
    "ReferenceLocation",
    "RerankingConfiguration",
    "RerankingFieldName",
    "RerankingMetadataConfiguration",
    "RerankingModelConfiguration",
    "RerankingSelectiveModeConfiguration",
    "RetrievalConfiguration",
    "RetrievedReference",
    "RowContent",
    "TextResponsePart",
    "TextResponsePartElement",
    # Shared stream types
    "ChatbotAction",
    "EConversationManagerType",
    "EStreamEvent",
    "InferenceConfig",
    "ModelConfiguration",
    "StrandToken",
    "Token",
    # Docker-specific types
    "AgentConfiguration",
]
