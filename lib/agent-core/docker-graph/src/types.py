# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, model_validator
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

DEFAULT_MAX_ITERATIONS = 50
DEFAULT_EXECUTION_TIMEOUT = 300.0  # 5 minutes
DEFAULT_NODE_TIMEOUT = 60.0  # 1 minute
TERMINAL_NODE = "__end__"


class GraphNodeDefinition(BaseModel):
    """A graph node that invokes a pre-existing AgentCore runtime."""

    id: str = Field(..., min_length=1)
    agentName: str = Field(..., min_length=1)
    endpointName: str = Field(default="DEFAULT", min_length=1)
    label: Optional[str] = None


class GraphEdgeDefinition(BaseModel):
    """A directed edge between two graph nodes, optionally conditional."""

    source: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)
    condition: Optional[str] = None


class GraphOrchestratorConfig(BaseModel):
    """Execution control settings for graph invocation."""

    maxIterations: int = Field(default=DEFAULT_MAX_ITERATIONS, ge=1)
    executionTimeoutSeconds: float = Field(default=DEFAULT_EXECUTION_TIMEOUT, gt=0)
    nodeTimeoutSeconds: float = Field(default=DEFAULT_NODE_TIMEOUT, gt=0)

    @model_validator(mode="after")
    def validate_timeout_consistency(self):
        """Validate that nodeTimeoutSeconds does not exceed executionTimeoutSeconds."""
        if self.nodeTimeoutSeconds > self.executionTimeoutSeconds:
            raise ValueError(
                f"nodeTimeoutSeconds ({self.nodeTimeoutSeconds}) must not exceed "
                f"executionTimeoutSeconds ({self.executionTimeoutSeconds})"
            )
        return self


class GraphConfiguration(BaseModel):
    """Configuration for a graph-based agent workflow."""

    nodes: list[GraphNodeDefinition] = Field(..., min_length=1)
    edges: list[GraphEdgeDefinition] = Field(default=[])
    entryPoint: str = Field(..., min_length=1)
    stateSchema: dict[str, str] = Field(default={})
    orchestrator: GraphOrchestratorConfig = GraphOrchestratorConfig()

    @model_validator(mode="after")
    def validate_unique_node_ids(self):
        """Validate that all node IDs are unique."""
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            duplicates = [i for i in ids if ids.count(i) > 1]
            raise ValueError(f"Duplicate node IDs: {set(duplicates)}")
        return self

    @model_validator(mode="after")
    def validate_entry_point(self):
        """Validate that the entry point references an existing node ID."""
        node_ids = {n.id for n in self.nodes}
        if self.entryPoint not in node_ids:
            raise ValueError(
                f"entryPoint '{self.entryPoint}' not found in nodes. "
                f"Available: {node_ids}"
            )
        return self

    @model_validator(mode="after")
    def validate_edge_references(self):
        """Validate that all edge source/target values reference valid nodes."""
        node_ids = {n.id for n in self.nodes}
        valid_targets = node_ids | {
            TERMINAL_NODE
        }  # __end__ is only valid as a target, not source
        for edge in self.edges:
            if edge.source not in node_ids:
                raise ValueError(f"Edge source '{edge.source}' not in nodes")
            if edge.target not in valid_targets:
                raise ValueError(f"Edge target '{edge.target}' not in nodes")
        return self

    @model_validator(mode="after")
    def validate_non_terminal_nodes_have_outgoing_edges(self):
        """Validate that every non-terminal node has at least one outgoing edge."""
        node_ids = {n.id for n in self.nodes}
        terminal_nodes = {
            edge.source for edge in self.edges if edge.target == TERMINAL_NODE
        }
        nodes_with_outgoing = {edge.source for edge in self.edges}

        for node_id in node_ids:
            if node_id not in terminal_nodes and node_id not in nodes_with_outgoing:
                raise ValueError(
                    f"Node '{node_id}' has no outgoing edges and is not terminal."
                )
        return self


__all__ = [
    # Graph-specific types
    "GraphNodeDefinition",
    "GraphEdgeDefinition",
    "GraphOrchestratorConfig",
    "GraphConfiguration",
    "TERMINAL_NODE",
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
