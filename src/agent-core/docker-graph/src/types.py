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


# Valid built-in node types that require no agent name or deterministic key.
BUILTIN_NODE_TYPES = frozenset({"fork", "dynamic_map"})


class DynamicMapConfig(BaseModel):
    """Configuration for a ``dynamic_map`` built-in node.

    A dynamic-map node reads a list from the graph state at runtime and
    spawns one parallel branch per item using LangGraph's ``Send()`` API.
    Each branch receives a copy of the current state with a single item
    injected into the field named by ``itemStateKey``.

    Attributes:
        sourceKey:    State field (or structured-output key) containing
                      the list to iterate over (e.g. ``"templates"``).
        targetNode:   Node ID that each ``Send()`` dispatches to
                      (e.g. ``"fill_template"``).
        itemStateKey: State field to set per-branch with the current
                      list item (e.g. ``"template_name"``).
    """

    sourceKey: str = Field(
        ...,
        min_length=1,
        description="State key containing the list to fan over.",
    )
    targetNode: str = Field(
        ...,
        min_length=1,
        description="Node ID to Send() each item to.",
    )
    itemStateKey: str = Field(
        ...,
        min_length=1,
        description="State key set per-branch with the current item.",
    )


class GraphNodeDefinition(BaseModel):
    """A graph node in a LangGraph pipeline.

    There are three mutually-exclusive node kinds, determined by which
    field is set:

    * **Agent node** (``agentName`` set) — invokes an external AgentCore
      runtime.  This is the original node kind.
    * **Deterministic node** (``deterministicNodeKey`` set) — calls a
      pure-Python function from the :mod:`deterministic_node_registry`.
      No LLM, no network call.  Used for the reduce step of a
      map-reduce pipeline.
    * **Fork node** (``nodeType == "fork"``) — built-in pass-through that
      emits the current state unchanged.  Used as the fan-out entry point
      of a parallel map phase; LangGraph runs all outgoing edges in
      parallel after this node.
    * **Dynamic map node** (``nodeType == "dynamic_map"``) — reads a list
      from state at runtime and uses ``Send()`` to spawn one parallel
      branch per item.
    """

    id: str = Field(..., min_length=1)
    # ── Agent node fields ────────────────────────────────────────────
    agentName: Optional[str] = Field(default=None, min_length=1)
    endpointName: str = Field(default="DEFAULT", min_length=1)
    # ── Deterministic node field ─────────────────────────────────────
    deterministicNodeKey: Optional[str] = Field(
        default=None,
        min_length=1,
        description=(
            "Registry key for a deterministic node function. "
            "Mutually exclusive with agentName and nodeType."
        ),
    )
    # ── Built-in node type ───────────────────────────────────────────
    nodeType: Optional[str] = Field(
        default=None,
        description=(
            "Built-in node type. 'fork' (pass-through fan-out) or "
            "'dynamic_map' (runtime Send()-based fan-out). "
            "Mutually exclusive with agentName and deterministicNodeKey."
        ),
    )
    # ── Dynamic map configuration (only for nodeType == "dynamic_map") ──
    dynamicMapConfig: Optional[DynamicMapConfig] = Field(
        default=None,
        description=(
            "Configuration for dynamic_map nodes. Specifies which state "
            "key holds the list, which node to Send() to, and which "
            "state key to set per branch."
        ),
    )
    label: Optional[str] = None
    # ── Per-node prompt override ─────────────────────────────────────
    promptTemplate: Optional[str] = Field(
        default=None,
        description=(
            "Optional prompt template for this node. Supports {variable} "
            "placeholders that are interpolated from the graph state and "
            "invocation extra state. When set, overrides the inherited "
            "'messages' prompt so each node can receive a task-specific "
            "instruction."
        ),
    )

    @model_validator(mode="after")
    def validate_node_kind(self):
        """Validate that exactly one node kind is specified."""
        has_agent = bool(self.agentName)
        has_det = bool(self.deterministicNodeKey)
        has_builtin = bool(self.nodeType)

        active = sum([has_agent, has_det, has_builtin])
        if active == 0:
            raise ValueError(
                f"Node '{self.id}' must specify exactly one of: "
                "'agentName', 'deterministicNodeKey', or 'nodeType'."
            )
        if active > 1:
            raise ValueError(
                f"Node '{self.id}' specifies more than one node kind. "
                "Use exactly one of: 'agentName', 'deterministicNodeKey', 'nodeType'."
            )
        if has_builtin and self.nodeType not in BUILTIN_NODE_TYPES:
            raise ValueError(
                f"Node '{self.id}': unknown nodeType '{self.nodeType}'. "
                f"Supported built-in types: {sorted(BUILTIN_NODE_TYPES)}."
            )
        return self


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
    stateClass: Optional[str] = Field(
        default=None,
        description=(
            "Registry key for a predefined state class. "
            "Mutually exclusive with stateSchema. When set, the factory "
            "resolves the state type from the state_registry instead of "
            "building a flat TypedDict from stateSchema."
        ),
    )
    orchestrator: GraphOrchestratorConfig = GraphOrchestratorConfig()

    @model_validator(mode="after")
    def validate_state_config(self):
        """Validate that stateClass and stateSchema are mutually exclusive."""
        if self.stateClass and self.stateSchema:
            raise ValueError(
                "Specify either 'stateClass' (predefined state) or "
                "'stateSchema' (custom flat fields), not both."
            )
        return self

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

        # dynamic_map nodes handle outgoing edges implicitly via Send()
        dynamic_map_node_ids = {n.id for n in self.nodes if n.nodeType == "dynamic_map"}
        for node_id in node_ids:
            if node_id in dynamic_map_node_ids:
                continue
            if node_id not in terminal_nodes and node_id not in nodes_with_outgoing:
                raise ValueError(
                    f"Node '{node_id}' has no outgoing edges and is not terminal."
                )
        return self


__all__ = [
    # Graph-specific types
    "DynamicMapConfig",
    "GraphNodeDefinition",
    "GraphEdgeDefinition",
    "GraphOrchestratorConfig",
    "GraphConfiguration",
    "TERMINAL_NODE",
    "BUILTIN_NODE_TYPES",
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
