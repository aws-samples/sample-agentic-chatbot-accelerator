# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import codecs
import json
import os
import re
import uuid
from typing import TYPE_CHECKING, Any, Tuple, TypedDict

from langgraph.graph import END, StateGraph
from shared.base_registry import get_agentcore_client, get_agentcore_control_client

from .types import (
    TERMINAL_NODE,
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
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

    raise RuntimeError(f"Agent runtime not found for agent name: {agent_name}")


def _parse_events(stream: str) -> Tuple[list[dict], str]:
    """Parse SSE events from a stream buffer and extract JSON events.

    Uses regex to find ``data: {...}`` patterns in the buffer, returning
    successfully parsed events and any remaining unparsed data that may
    contain an incomplete event to be completed by the next chunk.

    Args:
        stream: Raw stream data (potentially containing multiple SSE events).

    Returns:
        A tuple of (parsed_events, remaining_unparsed_data).
    """
    parsed_events: list[dict] = []
    unparsed_data = stream

    while True:
        event_match = re.search(r"data: ({.*?})\n", unparsed_data)
        if not event_match:
            break
        try:
            parsed_events.append(json.loads(event_match.group(1)))
            unparsed_data = (
                unparsed_data[: event_match.start()]
                + unparsed_data[event_match.end() :]
            )
        except json.JSONDecodeError:
            break

    return parsed_events, unparsed_data


def _invoke_agent(
    agent_name: str,
    endpoint_name: str,
    prompt: str,
    session_id: str,
    user_id: str,
    logger: Any = None,
) -> str:
    """Invoke a referenced AgentCore runtime and return its text response.

    Uses an incremental UTF-8 decoder and regex-based SSE event parsing to
    safely handle multi-byte characters that may be split across chunk
    boundaries.
    """
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

    # Use incremental decoder to handle UTF-8 characters split across chunk boundaries
    utf8_decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
    buffer = ""
    final_content = None
    token_values: list[str] = []
    received_any_chunk = False

    def _process_events(events: list[dict]) -> None:
        """Process parsed SSE events, extracting final content or tokens."""
        nonlocal final_content
        for event in events:
            action = event.get("action", "")
            data = event.get("data", {})

            if event.get("error"):
                raise RuntimeError(
                    f"Sub-agent '{agent_name}' returned error: {event['error']}"
                )

            if action == "final_response":
                final_content = data.get("content", "")
            elif action == "on_new_llm_token":
                token = data.get("token", {})
                if isinstance(token, dict) and "value" in token:
                    token_values.append(token["value"])

    try:
        if hasattr(response_stream, "__iter__"):
            for chunk in response_stream:
                received_any_chunk = True
                raw_bytes: bytes | None = None

                if isinstance(chunk, dict):
                    if "chunk" in chunk:
                        chunk_data = chunk["chunk"]
                        if isinstance(chunk_data, dict) and "bytes" in chunk_data:
                            raw_bytes = chunk_data["bytes"]
                        elif isinstance(chunk_data, bytes):
                            raw_bytes = chunk_data
                    elif "bytes" in chunk:
                        raw_bytes = chunk["bytes"]
                    elif "payload" in chunk:
                        payload_data = chunk["payload"]
                        raw_bytes = (
                            payload_data
                            if isinstance(payload_data, bytes)
                            else str(payload_data).encode()
                        )
                    else:
                        for val in chunk.values():
                            if isinstance(val, bytes):
                                raw_bytes = val
                                break
                            elif isinstance(val, str):
                                raw_bytes = val.encode()
                                break
                elif isinstance(chunk, bytes):
                    raw_bytes = chunk
                else:
                    raw_bytes = str(chunk).encode()

                if raw_bytes is None:
                    continue

                # final=False allows incomplete UTF-8 sequences at end of chunk
                decoded_text = utf8_decoder.decode(raw_bytes, final=False)
                events, buffer = _parse_events(buffer + decoded_text)
                _process_events(events)

                # Short-circuit if we already have the final response
                if final_content is not None:
                    break

        elif hasattr(response_stream, "read"):
            raw = response_stream.read()
            if raw:
                received_any_chunk = True
                raw_bytes = raw if isinstance(raw, bytes) else str(raw).encode()
                decoded_text = utf8_decoder.decode(raw_bytes, final=False)
                events, buffer = _parse_events(buffer + decoded_text)
                _process_events(events)

    except RuntimeError:
        raise
    except Exception as stream_err:
        raise RuntimeError(
            f"Failed to read response stream from agent '{agent_name}': {stream_err}"
        ) from stream_err

    # Flush any remaining bytes from the decoder
    final_text = utf8_decoder.decode(b"", final=True)
    if final_text:
        events, buffer = _parse_events(buffer + final_text)
        _process_events(events)

    if not received_any_chunk:
        raise RuntimeError(
            f"Empty response from agent '{agent_name}' — the agent may still "
            f"be initializing or the invocation timed out"
        )

    if final_content is not None:
        return final_content

    if token_values:
        return "".join(token_values)

    # Last resort: try parsing any remaining buffer as plain JSON (non-SSE response)
    remaining = buffer.strip()
    if remaining:
        try:
            parsed = json.loads(remaining)
            if isinstance(parsed, dict):
                if "error" in parsed:
                    raise RuntimeError(
                        f"Sub-agent '{agent_name}' returned error: {parsed['error']}"
                    )
                data = parsed.get("data", parsed)
                return str(data.get("content", data))
            return str(parsed)
        except json.JSONDecodeError:
            return remaining

    return ""


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
            error_msg = f"Node '{node_id}' (agent '{agent_name}'): {str(err)}"
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
