# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import json
import os
import uuid
from typing import TYPE_CHECKING, Any, TypedDict

from langgraph.graph import END, StateGraph
from langgraph.types import Send
from shared.base_registry import get_agentcore_client, get_agentcore_control_client
from shared.utils import AgentRuntimeResponse, parse_agent_runtime_response

from . import (  # noqa: F401 — triggers state + deterministic node registration
    states as _states,
)
from .deterministic_node_registry import resolve_deterministic_node
from .types import (
    TERMINAL_NODE,
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
)

if TYPE_CHECKING:
    from logging import Logger

ACCOUNT_ID = os.environ.get("accountId")


# ── Invocation-scoped extra state ───────────────────────────────────
# When the caller passes state fields (e.g. via the payload) but the
# LangGraph TypedDict schema doesn't declare them (e.g. stateSchema: {}),
# LangGraph silently drops them.  We store the caller-provided state here
# so node functions can always forward it to sub-agents as a fallback.
# Also accumulates structured outputs from each node.
_invocation_extra_state: dict[str, Any] = {}


def set_invocation_extra_state(
    state: dict[str, Any],
    *,
    session_id: str | None = None,
    user_id: str | None = None,
) -> None:
    """Store caller-provided state for the current invocation.

    Called by ``app.py`` before graph execution so that node functions
    can always forward these fields to sub-agents, regardless of
    whether the LangGraph state schema includes them.

    When *session_id* and *user_id* are provided they are stored under
    ``_session_id`` and ``_user_id`` keys so that deterministic nodes
    that need to invoke sub-agents can retrieve them.
    """
    global _invocation_extra_state
    _invocation_extra_state = dict(state) if state else {}
    if session_id is not None:
        _invocation_extra_state["_session_id"] = session_id
    if user_id is not None:
        _invocation_extra_state["_user_id"] = user_id


def get_invocation_extra_state() -> dict[str, Any]:
    """Return the accumulated invocation-scoped extra state.

    After graph execution, this dict contains:
    - Original caller-provided fields
    - Structured output keys from each node
    - Complete SO dicts stored under ``{node_id}_output``

    ``app.py`` uses this to extract structured outputs that couldn't
    flow through the LangGraph TypedDict state.
    """
    return dict(_invocation_extra_state)


_agent_runtime_cache: dict[str, str] = {}


def _fetch_agent_runtime_id(agent_name: str) -> str:
    """Resolve an agent name to its AgentCore runtime ID (cached)."""
    if agent_name in _agent_runtime_cache:
        return _agent_runtime_cache[agent_name]

    acc_client = get_agentcore_control_client()
    next_token = None

    while True:
        api_args: dict[str, Any] = {"maxResults": 10}
        if next_token:
            api_args["nextToken"] = next_token

        response = acc_client.list_agent_runtimes(**api_args)
        next_token = response.get("nextToken")

        for elem in response.get("agentRuntimes", []):
            if elem.get("agentRuntimeName") == agent_name:
                runtime_id = elem["agentRuntimeId"]
                _agent_runtime_cache[agent_name] = runtime_id
                return runtime_id

        if not next_token:
            break

    raise RuntimeError(f"Agent runtime not found for agent name: {agent_name}")


def _invoke_agent(
    agent_name: str,
    endpoint_name: str,
    prompt: str,
    session_id: str,
    user_id: str,
    logger: Any = None,
    state: dict | None = None,
) -> AgentRuntimeResponse:
    """Invoke a referenced AgentCore runtime and return a rich response.

    When *state* is provided it is JSON-serialised and included in the
    payload so the sub-agent can hydrate its own agent state.

    Delegates stream parsing to :func:`shared.utils.parse_agent_runtime_response`,
    which handles incremental UTF-8 decoding and SSE event extraction.
    """
    ac_client = get_agentcore_client()
    runtime_id = _fetch_agent_runtime_id(agent_name)

    # Unique sub-session so the referenced agent maintains its own conversation context
    node_session_id = f"{session_id}-graph-{agent_name}-{uuid.uuid4().hex[:8]}"

    payload_dict: dict[str, Any] = {
        "prompt": prompt,
        "userId": user_id,
    }
    if state:
        payload_dict["state"] = json.dumps(state)

    payload = json.dumps(payload_dict).encode()

    response = ac_client.invoke_agent_runtime(
        agentRuntimeArn=runtime_id,
        runtimeSessionId=node_session_id,
        runtimeUserId=user_id,
        payload=payload,
        qualifier=endpoint_name,
        accountId=ACCOUNT_ID,
    )

    result = parse_agent_runtime_response(
        response.get("response"),
        agent_name=agent_name,
        return_structured=True,
    )
    # parse_agent_runtime_response with return_structured=True always
    # returns AgentRuntimeResponse, but the type signature is a union
    # for backward compatibility.
    if not isinstance(result, AgentRuntimeResponse):
        raise TypeError(
            f"Expected AgentRuntimeResponse with return_structured=True, got {type(result).__name__}"
        )
    return result


def _concat_reducer(current: str, new: str) -> str:
    """Reducer: concatenates messages from parallel branches.

    When multiple parallel branches write to ``messages``, this reducer
    combines their outputs with a separator so all results are preserved
    in the final response.
    """
    if not current:
        return new
    return f"{current}\n\n---\n\n{new}"


def _build_state_type(
    state_schema: dict[str, str], has_parallel_nodes: bool = False
) -> type:
    """Build a TypedDict class from the user-defined state schema.

    Always ensures a ``messages`` field exists for passing the user
    message through the graph.

    When *has_parallel_nodes* is True (graph contains fork or dynamic_map
    nodes), the ``messages`` field is wrapped with an ``Annotated``
    last-writer-wins reducer so that parallel branches can both write
    to it without LangGraph raising INVALID_CONCURRENT_GRAPH_UPDATE.
    """
    from typing import Annotated

    type_map: dict[str, type] = {
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        "list": list,
        "dict": dict,
    }

    annotations: dict[str, type] = {}
    for field_name, type_str in state_schema.items():
        annotations[field_name] = type_map.get(type_str, str)

    if "messages" not in annotations:
        annotations["messages"] = str

    # When parallel branches exist, apply a reducer to messages
    # so concurrent writes don't cause INVALID_CONCURRENT_GRAPH_UPDATE
    if has_parallel_nodes:
        annotations["messages"] = Annotated[str, _concat_reducer]

    return TypedDict("GraphState", annotations)  # type: ignore[misc]


def compile_graph(
    configuration: GraphConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
) -> Any:
    """Compile a GraphConfiguration into a runnable LangGraph StateGraph.

    State resolution follows a hybrid approach:
    - If ``stateClass`` is set, the state type is resolved from the
      :mod:`state_registry` (supports rich TypedDicts with Annotated
      reducers, nested types, etc.).
    - Otherwise, a flat ``TypedDict`` is built dynamically from the
      ``stateSchema`` dict of primitives.
    """
    if configuration.stateClass:
        from .state_registry import resolve_state_class

        state_type = resolve_state_class(configuration.stateClass)
        logger.info(
            f"Using predefined state class '{configuration.stateClass}'",
            extra={"stateClass": configuration.stateClass},
        )
    else:
        # Detect if the graph has parallel nodes (fork or dynamic_map)
        # to automatically apply a last-writer-wins reducer on messages
        has_parallel = any(
            n.nodeType in ("fork", "dynamic_map") for n in configuration.nodes
        )
        state_type = _build_state_type(
            configuration.stateSchema, has_parallel_nodes=has_parallel
        )
        logger.info(
            "Using dynamic state schema",
            extra={
                "stateSchema": configuration.stateSchema,
                "hasParallelNodes": has_parallel,
            },
        )
    graph = StateGraph(state_type)

    for node_def in configuration.nodes:
        node_func = _make_node_function(
            node_def=node_def,
            logger=logger,
            session_id=session_id,
            user_id=user_id,
        )
        graph.add_node(node_def.id, node_func)  # type: ignore

    logger.info(
        "Added graph nodes",
        extra={
            "nodeCount": len(configuration.nodes),
            "nodeIds": [n.id for n in configuration.nodes],
        },
    )

    conditional_edges: dict[str, list[GraphEdgeDefinition]] = {}
    unconditional_edges: list[GraphEdgeDefinition] = []

    for edge in configuration.edges:
        if edge.condition:
            conditional_edges.setdefault(edge.source, []).append(edge)
        else:
            unconditional_edges.append(edge)

    for edge in unconditional_edges:
        target = END if edge.target == TERMINAL_NODE else edge.target
        graph.add_edge(edge.source, target)

    logger.info(
        "Added unconditional edges",
        extra={"edgeCount": len(unconditional_edges)},
    )

    for source, edges in conditional_edges.items():
        router = _make_conditional_router(edges, logger)
        path_map: dict[str, str] = {}
        for edge in edges:
            target = END if edge.target == TERMINAL_NODE else edge.target
            path_map[edge.target] = target

        graph.add_conditional_edges(source, router, path_map)  # type: ignore

    logger.info(
        "Added conditional edges",
        extra={
            "conditionalSourceCount": len(conditional_edges),
        },
    )

    # ── Dynamic-map nodes (Send()-based fan-out) ─────────────────────
    # For each dynamic_map node, wire a conditional edge whose router
    # returns a list of Send() objects — one per item in the source
    # list.  LangGraph runs all Send branches in parallel and merges
    # results via the state's Annotated[list, operator.add] reducers.
    dynamic_map_count = 0
    for node_def in configuration.nodes:
        if node_def.nodeType == "dynamic_map" and node_def.dynamicMapConfig:
            cfg = node_def.dynamicMapConfig
            dm_node_id = node_def.id

            def _make_send_router(
                source_key: str,
                target_node: str,
                item_state_key: str,
                _node_id: str,
            ):
                """Build a Send()-based router for a dynamic_map node.

                Closure factory to capture config per-node (avoids late-binding).
                """

                def send_router(state: dict) -> list[Send]:
                    # Try state first, then _invocation_extra_state
                    items = state.get(source_key) or []
                    if not items:
                        items = _invocation_extra_state.get(source_key) or []
                    # Fallback: look inside *_output dicts from previous nodes
                    if not items:
                        for key, val in _invocation_extra_state.items():
                            if key.endswith("_output") and isinstance(val, dict):
                                items = val.get(source_key) or []
                                if items:
                                    break

                    logger.info(
                        f"Dynamic-map '{_node_id}' sending {len(items)} "
                        f"branch(es) to '{target_node}'",
                        extra={
                            "nodeId": _node_id,
                            "targetNode": target_node,
                            "itemCount": len(items),
                        },
                    )

                    return [
                        Send(
                            target_node,
                            {**state, item_state_key: item},
                        )
                        for item in items
                    ]

                return send_router

            router = _make_send_router(
                source_key=cfg.sourceKey,
                target_node=cfg.targetNode,
                item_state_key=cfg.itemStateKey,
                _node_id=dm_node_id,
            )

            # Wire the conditional edge — no path_map needed for Send()
            graph.add_conditional_edges(dm_node_id, router)
            dynamic_map_count += 1

            logger.info(
                f"Dynamic-map node '{dm_node_id}' wired: "
                f"sourceKey='{cfg.sourceKey}' → "
                f"Send('{cfg.targetNode}', {cfg.itemStateKey}=<item>)",
                extra={
                    "nodeId": dm_node_id,
                    "sourceKey": cfg.sourceKey,
                    "targetNode": cfg.targetNode,
                    "itemStateKey": cfg.itemStateKey,
                },
            )

    if dynamic_map_count:
        logger.info(
            "Added dynamic-map edges",
            extra={"dynamicMapCount": dynamic_map_count},
        )

    graph.set_entry_point(configuration.entryPoint)

    compiled = graph.compile()

    logger.info(
        "Graph compiled successfully",
        extra={
            "entryPoint": configuration.entryPoint,
            "recursionLimit": configuration.orchestrator.maxIterations,
            "executionTimeout": configuration.orchestrator.executionTimeoutSeconds,
            "nodeTimeout": configuration.orchestrator.nodeTimeoutSeconds,
        },
    )

    return compiled


# Fields that are never forwarded as sub-agent state (they are internal
# to the graph or would cause confusion in the sub-agent).
_STATE_INTERNAL_FIELDS = frozenset({"messages"})


class _SafeFormatDict(dict):
    """A dict subclass that returns ``{key}`` for missing keys.

    Used with :meth:`str.format_map` so that unresolved placeholders
    in a ``promptTemplate`` are left as-is rather than raising
    :class:`KeyError`.
    """

    def __missing__(self, key: str) -> str:
        return f"{{{key}}}"


def _make_node_function(
    node_def: GraphNodeDefinition,
    logger: Logger,
    session_id: str,
    user_id: str,
):
    """Dispatch to the correct node factory based on the node kind.

    Three mutually-exclusive kinds are supported (validated in
    :class:`GraphNodeDefinition`):

    * **fork** (``nodeType == "fork"``) — built-in pass-through.
    * **dynamic_map** (``nodeType == "dynamic_map"``) — pass-through
      for Send()-based fan-out.
    * **deterministic** (``deterministicNodeKey`` set) — pure-Python
      function from the :mod:`deterministic_node_registry`.
    * **agent** (``agentName`` set) — calls an external AgentCore runtime.
    """
    if node_def.nodeType == "fork":
        return _make_fork_node_function(node_def, logger)
    elif node_def.nodeType == "dynamic_map":
        return _make_dynamic_map_node_function(node_def, logger)
    elif node_def.deterministicNodeKey:
        return _make_deterministic_node_function(node_def, logger)
    else:
        # agentName is guaranteed to be set by GraphNodeDefinition validation
        return _make_agent_node_function(node_def, logger, session_id, user_id)


def _make_fork_node_function(node_def: GraphNodeDefinition, logger: Logger):
    """Return a pass-through function that fans out to parallel branches.

    The fork node emits the current state's ``messages`` field unchanged.
    LangGraph runs all outgoing edges from this node in parallel.
    """
    node_id = node_def.id

    def fork_function(state: dict) -> dict:
        logger.info(
            f"Fork node '{node_id}': fanning out to parallel branches",
            extra={"nodeId": node_id},
        )
        return {"messages": state.get("messages", "")}

    return fork_function


def _make_dynamic_map_node_function(node_def: GraphNodeDefinition, logger: Logger):
    """Return a pass-through for a dynamic_map node.

    The dynamic_map node itself is a pass-through (like fork).  The actual
    fan-out happens via ``Send()`` in a conditional edge wired by
    ``compile_graph``.  This node function simply passes the state through
    so the conditional-edge router can read the list to fan over.
    """
    node_id = node_def.id

    def dynamic_map_function(state: dict) -> dict:
        logger.info(
            f"Dynamic-map node '{node_id}': preparing for Send()-based fan-out",
            extra={"nodeId": node_id},
        )
        return {"messages": state.get("messages", "")}

    return dynamic_map_function


def _make_deterministic_node_function(node_def: GraphNodeDefinition, logger: Logger):
    """Return a wrapper that calls a registered deterministic node function.

    The registered function receives the full graph state and must return
    a partial state-update dict.  The result is also written into
    ``_invocation_extra_state`` so ``app.py`` can extract it at the end.
    """
    node_id = node_def.id
    det_key = node_def.deterministicNodeKey  # guaranteed non-None by dispatch

    fn = resolve_deterministic_node(det_key)  # type: ignore[arg-type]

    def deterministic_function(state: dict) -> dict:
        logger.info(
            f"Deterministic node '{node_id}' running (key='{det_key}')",
            extra={"nodeId": node_id, "deterministicNodeKey": det_key},
        )
        try:
            result = fn(state)

            # Propagate outputs to extra state so app.py can surface them
            for key, value in result.items():
                if key not in _STATE_INTERNAL_FIELDS:
                    _invocation_extra_state[key] = value
            _invocation_extra_state[f"{node_id}_output"] = {
                k: v for k, v in result.items() if k not in _STATE_INTERNAL_FIELDS
            }

            logger.info(
                f"Deterministic node '{node_id}' completed",
                extra={
                    "nodeId": node_id,
                    "outputKeys": [
                        k for k in result if k not in _STATE_INTERNAL_FIELDS
                    ],
                },
            )
            return result

        except Exception as err:
            error_msg = f"Deterministic node '{node_id}' (key='{det_key}'): {err}"
            logger.error(
                f"Deterministic node '{node_id}' failed",
                extra={"nodeId": node_id, "rawErrorMessage": str(err)},
            )
            raise RuntimeError(error_msg) from err

    return deterministic_function


def _make_agent_node_function(
    node_def: GraphNodeDefinition,
    logger: Logger,
    session_id: str,
    user_id: str,
):
    """Create a closure that invokes the referenced AgentCore runtime.

    The closure is **state-aware**:

    * It forwards all non-internal graph-state fields to the sub-agent
      via the ``state`` key in the invocation payload.
    * When the sub-agent returns a ``structuredOutput``, the dict is
      merged back into the graph state.

    Node invocation errors are wrapped with the node ID and agent name
    for clear error attribution.
    """
    node_id = node_def.id
    agent_name: str = node_def.agentName  # type: ignore[assignment]
    endpoint_name = node_def.endpointName

    # Capture the prompt template at closure-creation time so each
    # node instance carries its own (or None for the default behavior).
    prompt_template: str | None = node_def.promptTemplate

    def node_function(state: dict) -> dict:
        """Execute the graph node by invoking the referenced agent."""
        logger.info(
            f"Executing agent node '{node_id}'",
            extra={
                "nodeId": node_id,
                "agentName": agent_name,
                "endpointName": endpoint_name,
                "hasPromptTemplate": prompt_template is not None,
            },
        )

        # ── Resolve the prompt ──────────────────────────────────────
        # When a promptTemplate is configured for this node, use it
        # instead of the inherited graph-level 'messages'.  Placeholders
        # like {variable} are interpolated from the combined graph state
        # + invocation extra state.
        if prompt_template:
            fmt_vars = {**_invocation_extra_state, **state}
            try:
                prompt = prompt_template.format_map(_SafeFormatDict(fmt_vars))
            except (ValueError, IndexError):
                # Malformed template — fall back to the raw template string
                prompt = prompt_template
            logger.info(
                f"Node '{node_id}' using custom prompt template",
                extra={
                    "nodeId": node_id,
                    "promptLength": len(prompt),
                },
            )
        else:
            prompt = state.get("messages", "")
            if isinstance(prompt, list):
                prompt = str(prompt[-1]) if prompt else ""

        # Build sub-agent state from all non-internal graph state fields.
        # DEFENSIVE FALLBACK: When the LangGraph TypedDict schema
        # doesn't include caller-provided fields, we merge
        # _invocation_extra_state first as a base, then overlay
        # whatever the graph state actually has.
        agent_state: dict[str, Any] = {}

        # 1) Start with invocation-scoped extra state (fallback)
        for key, value in _invocation_extra_state.items():
            if key not in _STATE_INTERNAL_FIELDS and value is not None:
                agent_state[key] = value

        # 2) Overlay with actual graph state (takes precedence)
        for key, value in state.items():
            if key not in _STATE_INTERNAL_FIELDS and value is not None:
                agent_state[key] = value

        try:
            result = _invoke_agent(
                agent_name=agent_name,
                endpoint_name=endpoint_name,
                prompt=str(prompt),
                session_id=session_id,
                user_id=user_id,
                logger=logger,
                state=agent_state if agent_state else None,
            )

            logger.info(
                f"Agent node '{node_id}' completed",
                extra={
                    "nodeId": node_id,
                    "agentName": agent_name,
                    "responseLength": len(result.content),
                    "hasStructuredOutput": result.structured_output is not None,
                },
            )

            # Start with the text response on the messages channel
            state_update: dict[str, Any] = {"messages": result.content}
            so = result.structured_output

            # Merge structured output into the graph state
            if so:
                state_fields = set(state.keys())

                merged_keys: list[str] = []
                for so_key, so_value in so.items():
                    if so_key in state_fields and so_key not in _STATE_INTERNAL_FIELDS:
                        state_update[so_key] = so_value
                        merged_keys.append(so_key)

                # ── Propagate SO to _invocation_extra_state ─────────
                # When the LangGraph state schema is minimal or the SO
                # keys don't match state fields, structured output keys
                # would be lost.  By storing them in
                # _invocation_extra_state, the next node function's
                # state-building step will forward them to sub-agents
                # as fallback state.
                for so_key, so_value in so.items():
                    if so_key not in _STATE_INTERNAL_FIELDS:
                        _invocation_extra_state[so_key] = so_value

                # Also store the complete SO dict under the node_id
                # so it can be forwarded as a single object.
                _invocation_extra_state[f"{node_id}_output"] = so

                # Write the full SO under the node_id in the state
                # update as well.  If the stateClass declares a field
                # matching the node_id, LangGraph will pick it up.
                if node_id in state_fields:
                    state_update[node_id] = so

                # ── Accumulate partial_templates for map-reduce ──────
                # When the state has a ``partial_templates`` list field,
                # each agent node appends its structured output as a
                # tagged entry so the reduce node can distinguish sources.
                if "partial_templates" in state_fields:
                    state_update["partial_templates"] = [
                        {"source": node_id, "data": so}
                    ]

                # Accumulate filled_templates for classify-fill pipelines.
                if "filled_templates" in state_fields:
                    tmpl_name = state.get(
                        "template_name"
                    ) or _invocation_extra_state.get("template_name", "")
                    if tmpl_name:
                        state_update["filled_templates"] = [
                            {"template_name": tmpl_name, **so}
                        ]

                logger.info(
                    f"Structured output from agent node '{node_id}' merged into state",
                    extra={
                        "nodeId": node_id,
                        "structuredOutputKeys": list(so.keys()),
                        "mergedStateKeys": merged_keys,
                        "propagatedToExtraState": True,
                    },
                )

            return state_update

        except Exception as err:
            error_msg = f"Node '{node_id}' (agent '{agent_name}'): {str(err)}"
            logger.error(
                f"Agent node '{node_id}' failed",
                extra={
                    "nodeId": node_id,
                    "agentName": agent_name,
                    "rawErrorMessage": str(err),
                },
            )
            raise RuntimeError(error_msg) from err

    return node_function


def _make_conditional_router(
    edges: list[GraphEdgeDefinition],
    logger: Logger,
):
    """Create a routing function for conditional edges from a single source.

    Checks if the condition string appears (case-insensitive) in the current
    messages state. Falls back to the first edge's target if nothing matches.
    """

    def router(state: dict) -> str:
        """Match condition strings against the messages state."""
        messages = state.get("messages", "")
        if isinstance(messages, list):
            output_text = str(messages[-1]) if messages else ""
        else:
            output_text = str(messages)

        output_lower = output_text.lower()

        for edge in edges:
            condition = (edge.condition or "").strip().lower()
            if not condition:
                continue

            if condition in output_lower:
                logger.info(
                    f"Conditional edge matched: {edge.source} -> {edge.target}",
                    extra={
                        "condition": edge.condition,
                        "source": edge.source,
                        "target": edge.target,
                        "matchedIn": output_text[:200],
                    },
                )
                return edge.target

        fallback = edges[0].target
        logger.info(
            f"No conditional edge matched, using fallback: {fallback}",
            extra={"fallbackTarget": fallback},
        )
        return fallback

    return router
