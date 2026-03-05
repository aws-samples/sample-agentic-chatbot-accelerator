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

from shared.base_registry import get_agentcore_client, get_agentcore_control_client

from .types import (
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
    TERMINAL_NODE,
)

if TYPE_CHECKING:
    from logging import Logger

ACCOUNT_ID = os.environ.get("accountId")


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

    raise RuntimeError(
        f"Agent runtime not found for agent name: {agent_name}"
    )


def _invoke_agent(
    agent_name: str,
    endpoint_name: str,
    prompt: str,
    session_id: str,
    user_id: str,
    logger: Any = None,
) -> str:
    """Invoke a referenced AgentCore runtime and return its text response."""
    ac_client = get_agentcore_client()
    runtime_id = _fetch_agent_runtime_id(agent_name)

    # Unique sub-session so the referenced agent maintains its own conversation context
    node_session_id = f"{session_id}-graph-{agent_name}-{uuid.uuid4().hex[:8]}"

    payload = json.dumps(
        {
            "prompt": prompt,
            "userId": user_id,
        }
    ).encode()

    response = ac_client.invoke_agent_runtime(
        agentRuntimeArn=runtime_id,
        runtimeSessionId=node_session_id,
        runtimeUserId=user_id,
        payload=payload,
        qualifier=endpoint_name,
        accountId=ACCOUNT_ID,
    )

    response_stream = response.get("response")

    chunks = []
    try:
        if hasattr(response_stream, '__iter__'):
            for event in response_stream:
                if isinstance(event, dict):
                    if "chunk" in event:
                        chunk_data = event["chunk"]
                        if isinstance(chunk_data, dict) and "bytes" in chunk_data:
                            chunks.append(chunk_data["bytes"].decode("utf-8"))
                        elif isinstance(chunk_data, bytes):
                            chunks.append(chunk_data.decode("utf-8"))
                        else:
                            chunks.append(str(chunk_data))
                    elif "bytes" in event:
                        chunks.append(event["bytes"].decode("utf-8"))
                    elif "payload" in event:
                        payload_data = event["payload"]
                        if isinstance(payload_data, bytes):
                            chunks.append(payload_data.decode("utf-8"))
                        else:
                            chunks.append(str(payload_data))
                    else:
                        for key, val in event.items():
                            if isinstance(val, bytes):
                                chunks.append(val.decode("utf-8"))
                            elif isinstance(val, str):
                                chunks.append(val)
                elif isinstance(event, bytes):
                    chunks.append(event.decode("utf-8"))
                else:
                    chunks.append(str(event))
        elif hasattr(response_stream, 'read'):
            raw = response_stream.read()
            if raw:
                chunks.append(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
    except Exception as stream_err:
        raise RuntimeError(
            f"Failed to read response stream from agent '{agent_name}': {stream_err}"
        ) from stream_err

    if not chunks:
        raise RuntimeError(
            f"Empty response from agent '{agent_name}' — the agent may still "
            f"be initializing or the invocation timed out"
        )

    full_response = "".join(chunks)

    # SSE format: data: {"action": "on_new_llm_token", "data": {"token": {"value": "Hello"}}}\n\n
    final_content = None
    token_values = []

    for line in full_response.split("\n"):
        line = line.strip()
        if not line or not line.startswith("data: "):
            continue

        json_str = line[6:]  # Strip "data: " prefix
        try:
            event = json.loads(json_str)
        except json.JSONDecodeError:
            continue

        action = event.get("action", "")
        data = event.get("data", {})

        if action == "final_response":
            final_content = data.get("content", "")
            break
        elif action == "on_new_llm_token":
            token = data.get("token", {})
            if isinstance(token, dict) and "value" in token:
                token_values.append(token["value"])

    if final_content is not None:
        return final_content

    if token_values:
        return "".join(token_values)

    # Last resort: try parsing as plain JSON (non-SSE response)
    try:
        parsed = json.loads(full_response)
        if isinstance(parsed, dict):
            if "error" in parsed:
                raise RuntimeError(
                    f"Sub-agent '{agent_name}' returned error: {parsed['error']}"
                )
            data = parsed.get("data", parsed)
            return str(data.get("content", data))
        return str(parsed)
    except json.JSONDecodeError:
        return full_response.strip()


def _build_state_type(state_schema: dict[str, str]) -> type:
    """Build a TypedDict class from the user-defined state schema.

    Always ensures a ``messages`` field exists for passing the user
    message through the graph.
    """
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

    return TypedDict("GraphState", annotations)  # type: ignore[misc]


def compile_graph(
    configuration: GraphConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
) -> Any:
    """Compile a GraphConfiguration into a runnable LangGraph StateGraph."""
    state_type = _build_state_type(configuration.stateSchema)
    graph = StateGraph(state_type)

    for node_def in configuration.nodes:
        node_func = _make_node_function(
            node_def=node_def,
            logger=logger,
            session_id=session_id,
            user_id=user_id,
        )
        graph.add_node(node_def.id, node_func)

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

        graph.add_conditional_edges(source, router, path_map)

    logger.info(
        "Added conditional edges",
        extra={
            "conditionalSourceCount": len(conditional_edges),
        },
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


def _make_node_function(
    node_def: GraphNodeDefinition,
    logger: Logger,
    session_id: str,
    user_id: str,
):
    """Create a closure that invokes the referenced agent for a graph node.

    Node invocation errors are wrapped with the node ID and agent name
    for clear error attribution.
    """
    node_id = node_def.id
    agent_name = node_def.agentName
    endpoint_name = node_def.endpointName

    def node_function(state: dict) -> dict:
        """Execute the graph node by invoking the referenced agent."""
        logger.info(
            f"Executing graph node '{node_id}'",
            extra={
                "nodeId": node_id,
                "agentName": agent_name,
                "endpointName": endpoint_name,
            },
        )

        prompt = state.get("messages", "")
        if isinstance(prompt, list):
            prompt = str(prompt[-1]) if prompt else ""

        try:
            result = _invoke_agent(
                agent_name=agent_name,
                endpoint_name=endpoint_name,
                prompt=str(prompt),
                session_id=session_id,
                user_id=user_id,
                logger=logger,
            )

            logger.info(
                f"Graph node '{node_id}' completed",
                extra={
                    "nodeId": node_id,
                    "agentName": agent_name,
                    "responseLength": len(result),
                },
            )

            # LangGraph replaces state rather than appending
            return {"messages": result}

        except Exception as err:
            error_msg = (
                f"Node '{node_id}' (agent '{agent_name}'): {str(err)}"
            )
            logger.error(
                f"Graph node '{node_id}' failed",
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
