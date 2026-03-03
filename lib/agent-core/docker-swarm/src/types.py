# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from pydantic import BaseModel, model_validator

# Re-export KB types from shared for backwards compatibility
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

# Import shared types instead of redefining them
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
# Swarm-Specific Constants
# ============================================================================ #
DEFAULT_MAX_HANDOFFS = 10
DEFAULT_MAX_ITERATIONS = 20
DEFAULT_EXECUTION_TIMEOUT = 300.0  # 5 minutes
DEFAULT_NODE_TIMEOUT = 60.0  # 1 minute
DEFAULT_REPETITIVE_HANDOFF_DETECTION_WINDOW = 5
DEFAULT_REPETITIVE_HANDOFF_MIN_UNIQUE_AGENTS = 2

# ============================================================================ #
# Swarm-Specific Types
# ============================================================================ #


class SwarmOrchestratorConfig(BaseModel):
    """Configuration for swarm execution controls.

    Attributes:
        maxHandoffs (int): Maximum times agents can hand off to each other
        maxIterations (int): Maximum total iterations across all agents
        executionTimeoutSeconds (float): Total swarm execution timeout in seconds
        nodeTimeoutSeconds (float): Timeout per individual agent in seconds
        repetitiveHandoffDetectionWindow (int): Window size for detecting handoff loops
        repetitiveHandoffMinUniqueAgents (int): Min unique agents required in window
    """

    maxHandoffs: int = DEFAULT_MAX_HANDOFFS
    maxIterations: int = DEFAULT_MAX_ITERATIONS
    executionTimeoutSeconds: float = DEFAULT_EXECUTION_TIMEOUT
    nodeTimeoutSeconds: float = DEFAULT_NODE_TIMEOUT
    repetitiveHandoffDetectionWindow: int = DEFAULT_REPETITIVE_HANDOFF_DETECTION_WINDOW
    repetitiveHandoffMinUniqueAgents: int = DEFAULT_REPETITIVE_HANDOFF_MIN_UNIQUE_AGENTS


class SwarmAgentDefinition(BaseModel):
    """Definition for an individual agent within a swarm.

    Attributes:
        name (str): Unique name identifier for this agent within the swarm
        instructions (str): System prompt defining the agent's role and behavior
        modelInferenceParameters (ModelConfiguration): Model and inference settings
        tools (list[str]): List of tool names this agent can use
        toolParameters (dict[str, dict]): Parameters for each tool
        mcpServers (list[str]): List of MCP server names to connect
    """

    name: str
    instructions: str
    modelInferenceParameters: ModelConfiguration
    tools: list[str] = []
    toolParameters: dict[str, dict] = {}
    mcpServers: list[str] = []

    @model_validator(mode="after")
    def validate_and_sanitize_name(self):
        """Validates and sanitizes agent name to match required pattern.

        The name must match: [a-zA-Z0-9][a-zA-Z0-9-_/]*
        """
        import re

        # Sanitize: replace spaces with underscores, remove invalid chars
        sanitized = re.sub(r"[^a-zA-Z0-9-_/]", "_", self.name)
        # Ensure it starts with alphanumeric
        if sanitized and not sanitized[0].isalnum():
            sanitized = "agent_" + sanitized
        # Ensure not empty
        if not sanitized:
            sanitized = "agent"

        self.name = sanitized
        return self

    @model_validator(mode="after")
    def validate_tool_parameters(self):
        """Validates that tool parameters match the defined tools."""
        tool_names = {tool_name for tool_name in self.tools}
        invalid_keys = set(self.toolParameters.keys()) - tool_names
        if invalid_keys:
            raise ValueError(f"toolParameters keys {invalid_keys} not found in tools")
        return self


class AgentReference(BaseModel):
    """Reference to an existing agent for use in a swarm.

    Attributes:
        agentName (str): Name of the existing agent in DynamoDB
        endpointName (str): Endpoint qualifier (e.g. "DEFAULT", "BASELINE")
    """

    agentName: str
    endpointName: str


class SwarmConfiguration(BaseModel):
    """Configuration for a swarm of agents.

    Supports two modes:
    1. Inline agents: Full agent definitions embedded in the swarm config
    2. Referenced agents: References to existing agents that are loaded at runtime

    Attributes:
        agents (list[SwarmAgentDefinition]): List of inline agent definitions (optional)
        agentReferences (list[AgentReference]): References to existing agents (optional)
        entryAgent (str): Name of the agent that handles initial messages
        orchestrator (SwarmOrchestratorConfig): Swarm execution control settings
        conversationManager (EConversationManagerType): How to manage conversation history
    """

    agents: list[SwarmAgentDefinition] = []
    agentReferences: list[AgentReference] = []
    entryAgent: str
    orchestrator: SwarmOrchestratorConfig = SwarmOrchestratorConfig()
    conversationManager: EConversationManagerType = (
        EConversationManagerType.SLIDING_WINDOW
    )

    @model_validator(mode="after")
    def validate_has_agents(self):
        """Validates that at least one agent source is provided."""
        if not self.agents and not self.agentReferences:
            raise ValueError(
                "SwarmConfiguration must have either 'agents' or 'agentReferences'"
            )
        return self

    @model_validator(mode="after")
    def validate_entry_agent(self):
        """Validates that the entry agent exists in the agents list or references."""
        # If using inline agents, validate entry agent exists
        if self.agents:
            agent_names = {agent.name for agent in self.agents}
            if self.entryAgent not in agent_names:
                raise ValueError(
                    f"entryAgent '{self.entryAgent}' not found in agents. "
                    f"Available agents: {agent_names}"
                )
        # If using references, validation happens after loading in data_source
        elif self.agentReferences:
            ref_names = {ref.agentName for ref in self.agentReferences}
            if self.entryAgent not in ref_names:
                raise ValueError(
                    f"entryAgent '{self.entryAgent}' not found in agentReferences. "
                    f"Available references: {ref_names}"
                )
        return self

    @model_validator(mode="after")
    def validate_unique_agent_names(self):
        """Validates that all agent names are unique."""
        if self.agents:
            agent_names = [agent.name for agent in self.agents]
            if len(agent_names) != len(set(agent_names)):
                duplicates = [
                    name for name in agent_names if agent_names.count(name) > 1
                ]
                raise ValueError(f"Duplicate agent names found: {set(duplicates)}")
        if self.agentReferences:
            ref_names = [ref.agentName for ref in self.agentReferences]
            if len(ref_names) != len(set(ref_names)):
                duplicates = [name for name in ref_names if ref_names.count(name) > 1]
                raise ValueError(f"Duplicate agent references found: {set(duplicates)}")
        return self


# Re-export all types for backwards compatibility
__all__ = [
    # Swarm-specific types
    "SwarmOrchestratorConfig",
    "SwarmAgentDefinition",
    "AgentReference",
    "SwarmConfiguration",
    # Shared stream types (re-exported)
    "ChatbotAction",
    "EConversationManagerType",
    "EStreamEvent",
    "InferenceConfig",
    "ModelConfiguration",
    "StrandToken",
    "Token",
    # Shared KB types (re-exported)
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
]
