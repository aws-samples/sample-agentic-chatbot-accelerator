# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import Optional

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


class AgentAsTool(BaseModel):
    """Configuration of sub-agents uses as tools in an agents as tool framework

    Attribute:
        runtimeId (str): identifier of the runtime
        endpoint (str): name of the endpoint
        role (str): role that the tool covers from the perspective of the orchestrator
    """

    runtimeId: str
    endpoint: str
    role: str


class OrchestratorConfiguration(BaseModel):
    """Configuration for the orchestrator of an agents as tool framework.

    Attributes:
        modelInferenceParameters (ModelConfiguration): Model and inference settings of the orchestrator agent
        instructions (str): System prompt defining the orchestrator's role and behavior
        agentsAsTools (list[AgentAsTool]): List of sub-agents exposed as tools to the orchestrator
        tools (Optional[list[str]]): List of tool names this agent can use. Must be provided together with toolParameters, or both omitted.
        toolParameters (Optional[dict[str, dict]]): Parameters for each tool. Must be provided together with tools, or both omitted.
        mcpServers (Optional[list[str]]): List of MCP server names to connect
        conversationManager (EConversationManagerType): How to manage conversation history
    """

    modelInferenceParameters: ModelConfiguration
    instructions: str
    agentsAsTools: list[AgentAsTool]
    tools: Optional[list[str]] = None
    toolParameters: Optional[dict[str, dict]] = None
    mcpServers: Optional[list[str]] = None
    conversationManager: EConversationManagerType = (
        EConversationManagerType.SLIDING_WINDOW
    )

    @model_validator(mode="after")
    def validate_tool_parameters(self):
        """Validates that tools and toolParameters are consistent.

        Checks that:
        - Both tools and toolParameters are provided, or neither is
        - All toolParameters keys correspond to defined tools

        Returns:
            OrchestratorConfiguration: The validated configuration object

        Raises:
            ValueError: If only one of tools/toolParameters is provided,
                        or if toolParameters keys don't match defined tools
        """
        if self.tools is None and self.toolParameters is None:
            return self
        if self.tools is None or self.toolParameters is None:
            raise ValueError(
                "tools and toolParameters must both be provided or both be omitted"
            )
        tool_names = set(self.tools)
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
    "OrchestratorConfiguration",
]
