# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import asyncio
import json
import logging
import os
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.session_history import save_conversation_exchange
from shared.utils import get_uvicorn_host
from src.data_source import parse_configuration
from src.factory import (
    compile_graph,
    get_invocation_extra_state,
    set_invocation_extra_state,
)

logger = logging.getLogger("agentcore.app")
logger.setLevel(logging.INFO)

app = FastAPI()

COMPILED_GRAPH = None
CURRENT_SESSION_ID: str | None = None
CONFIGURATION = None

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


# ============================================================
# Node-step streaming
# ============================================================
async def stream_graph_with_steps(
    compiled_graph,
    input_state: dict,
    invoke_config: dict,
    node_ids: set[str],
    websocket,
) -> dict:
    """Run the graph via ``astream_events`` and emit per-node tool steps.

    Graph nodes invoke sub-agent runtimes rather than local tools, so the
    Strands tool callbacks never fire for a graph run. Instead we stream the
    graph's own node lifecycle and surface each node execution as a step,
    reusing the spec-02 ``tool_action`` / ``tool_complete`` WS contract
    verbatim — the graph just becomes another producer of those events, so no
    frontend change is needed.

    ``astream_events`` (v2) emits ``on_chain_start`` / ``on_chain_end`` per
    node for free. Conditional routers are edge functions (not ``add_node``),
    so their chain events are naturally excluded by the ``name in node_ids``
    test, keeping the step list to meaningful nodes only.

    A distinct ``run_id`` per node execution means ``Send()`` fan-out branches
    and revision-loop re-entries each become their own step. Repeated
    executions of the same node id are disambiguated with a ``#k`` label
    suffix so the UI keys stay unique.

    Args:
        compiled_graph: The compiled LangGraph to execute.
        input_state: Initial graph state.
        invoke_config: LangGraph invoke config (recursion_limit, etc.).
        node_ids: Registered node ids — only these surface as steps.
        websocket: Browser-facing WebSocket for step events.

    Returns:
        The graph's final merged state — identical to what ``ainvoke`` would
        return — so the caller's final_content / structured-output extraction
        is unchanged.
    """
    result: dict = {}
    # Per-execution metadata keyed by LangGraph run_id.
    run_meta: dict[str, dict] = {}
    node_starts: dict[str, int] = {}  # node_id -> number of times started
    seq = 0  # monotonic invocationNumber across all nodes
    root_run_id: str | None = None

    async for event in compiled_graph.astream_events(
        input_state, config=invoke_config, version="v2"
    ):
        kind = event.get("event")
        name = event.get("name")
        run_id = event.get("run_id")

        # The first chain to start is the graph root; its matching
        # on_chain_end carries the final merged state.
        if kind == "on_chain_start" and root_run_id is None:
            root_run_id = run_id

        if kind == "on_chain_start" and name in node_ids:
            seq += 1
            occ = node_starts.get(name, 0) + 1
            node_starts[name] = occ
            label = name if occ == 1 else f"{name} #{occ}"
            run_meta[run_id] = {"seq": seq, "label": label}
            await websocket.send_json(
                {
                    "type": "tool_action",
                    "toolName": label,
                    "description": "",
                    "parameters": [],
                    "invocationNumber": seq,
                }
            )

        elif kind == "on_chain_end":
            if run_id == root_run_id:
                output = event.get("data", {}).get("output")
                if isinstance(output, dict):
                    result = output
            meta = run_meta.pop(run_id, None)
            if meta is not None:
                await websocket.send_json(
                    {
                        "type": "tool_complete",
                        "toolName": meta["label"],
                        "invocationNumber": meta["seq"],
                        "status": "success",
                    }
                )

        elif kind == "on_chain_error":
            meta = run_meta.pop(run_id, None)
            if meta is not None:
                await websocket.send_json(
                    {
                        "type": "tool_complete",
                        "toolName": meta["label"],
                        "invocationNumber": meta["seq"],
                        "status": "error",
                    }
                )

    return result


# ============================================================
# Health Check (required by AgentCore)
# ============================================================
@app.get("/ping")
async def ping():
    return {"status": "Healthy", "time_of_last_update": int(datetime.now().timestamp())}


# ============================================================
# TEXT MODE: WebSocket endpoint (complete response, no streaming)
# ============================================================
@app.websocket("/ws")
async def graph_text_chat(websocket: WebSocket):
    """
    Text WebSocket for Graph — sends complete response (no token streaming).
    Graph execution is blocking; voice mode is NOT supported.
    """
    global COMPILED_GRAPH, CURRENT_SESSION_ID, CONFIGURATION

    await websocket.accept()
    logger.info("Graph Text WebSocket connection accepted")

    try:
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")

            if msg_type == "text_input":
                user_message = message.get("text", "Hello")
                user_id = message.get("userId")
                message_id = message.get("messageId")
                session_id = message.get("sessionId")

                ctx = baggage.set_baggage("session.id", session_id)
                attach(ctx)

                # ── Parse optional session state from payload ─────────
                # The caller may provide initial state fields that the
                # graph nodes should forward to sub-agents.
                state_json = message.get("state")
                initial_extra_state: dict = {}
                if state_json:
                    initial_extra_state = (
                        json.loads(state_json)
                        if isinstance(state_json, str)
                        else state_json
                    )
                    logger.info(
                        "Graph initial state hydrated from payload",
                        extra={"stateKeys": list(initial_extra_state.keys())},
                    )

                # Store the extra state so node functions can always
                # forward it to sub-agents.
                set_invocation_extra_state(
                    initial_extra_state,
                    session_id=session_id,
                    user_id=user_id,
                )

                if COMPILED_GRAPH is None or CURRENT_SESSION_ID != session_id:
                    logger.info(
                        "Initializing graph for session",
                        extra={
                            "context": {
                                "sessionId": session_id,
                                "userId": user_id,
                            }
                        },
                    )

                    try:
                        CONFIGURATION = parse_configuration(logger)
                        logger.info(
                            "Graph configuration loaded",
                            extra={
                                "nodeCount": len(CONFIGURATION.nodes),
                                "edgeCount": len(CONFIGURATION.edges),
                                "entryPoint": CONFIGURATION.entryPoint,
                            },
                        )

                        if MEMORY_ID and session_id:
                            logger.warning(
                                "Memory/session persistence is not yet supported for Graph agents. "
                                "Skipping session manager creation.",
                                extra={"context": {"memoryId": MEMORY_ID}},
                            )

                        COMPILED_GRAPH = compile_graph(
                            configuration=CONFIGURATION,
                            logger=logger,
                            session_id=session_id,
                            user_id=user_id,
                        )
                        CURRENT_SESSION_ID = session_id

                        logger.info(
                            "Graph initialized successfully",
                            extra={
                                "nodeIds": [n.id for n in CONFIGURATION.nodes],
                                "entryPoint": CONFIGURATION.entryPoint,
                            },
                        )

                    except Exception as err:
                        logger.error(
                            "Failed to initialize graph",
                            extra={"rawErrorMessage": str(err)},
                        )
                        await websocket.send_json(
                            {"type": "error", "message": str(err)}
                        )
                        continue

                logger.info(
                    "Calling graph with user message and context",
                    extra={
                        "prompt": user_message,
                        "context": {
                            "sessionId": session_id,
                            "userId": user_id,
                        },
                    },
                )

                try:
                    input_state: dict = {"messages": [user_message]}
                    input_state.update(initial_extra_state)

                    invoke_config = {
                        "recursion_limit": CONFIGURATION.orchestrator.maxIterations,
                    }

                    timeout_seconds = CONFIGURATION.orchestrator.executionTimeoutSeconds

                    # Stream the graph and surface each node as a tool step.
                    # Returns the final merged state (same as ainvoke), so the
                    # final_content / structured-output extraction is unchanged.
                    node_ids = {n.id for n in CONFIGURATION.nodes}
                    result = await asyncio.wait_for(
                        stream_graph_with_steps(
                            compiled_graph=COMPILED_GRAPH,
                            input_state=input_state,
                            invoke_config=invoke_config,
                            node_ids=node_ids,
                            websocket=websocket,
                        ),
                        timeout=timeout_seconds,
                    )

                    logger.info(
                        "Graph completed",
                        extra={
                            "resultKeys": (
                                list(result.keys())
                                if isinstance(result, dict)
                                else None
                            ),
                        },
                    )

                    final_content = ""
                    if isinstance(result, dict):
                        messages = result.get("messages", "")
                        if isinstance(messages, str):
                            final_content = messages
                        elif isinstance(messages, list) and messages:
                            last_message = messages[-1]
                            final_content = (
                                str(last_message)
                                if not isinstance(last_message, str)
                                else last_message
                            )
                        else:
                            final_content = str(result)
                    else:
                        final_content = str(result)

                    final_data: dict = {
                        "type": "final_response",
                        "content": final_content,
                        "sessionId": session_id,
                        "messageId": message_id,
                    }

                    # ── Extract structured output ─────────────────────
                    # Collect structured outputs from two sources:
                    #
                    # 1. LangGraph final state — dict fields whose keys
                    #    match the TypedDict schema (non-messages).
                    #
                    # 2. _invocation_extra_state — accumulated SO from
                    #    each node stored under ``{node_id}_output``.
                    structured_fields: dict = {}

                    # Source 1: LangGraph final state
                    if isinstance(result, dict):
                        for key, value in result.items():
                            if key == "messages":
                                continue
                            if isinstance(value, dict) and value:
                                structured_fields[key] = value
                            elif isinstance(value, list) and value:
                                structured_fields[key] = value

                    # Source 2: invocation extra state (_output keys)
                    extra_state = get_invocation_extra_state()
                    for key, value in extra_state.items():
                        if (
                            key.endswith("_output")
                            and isinstance(value, dict)
                            and value
                        ):
                            clean_key = key.removesuffix("_output")
                            if clean_key not in structured_fields:
                                structured_fields[clean_key] = value

                    if structured_fields:
                        final_data["structuredOutput"] = json.dumps(structured_fields)
                        logger.info(
                            "Structured output extracted",
                            extra={
                                "structuredOutputKeys": list(structured_fields.keys()),
                            },
                        )

                    await websocket.send_json(final_data)

                    # Save conversation to session history
                    try:
                        save_conversation_exchange(
                            session_id=session_id,
                            user_id=user_id,
                            message_id=message_id,
                            user_message=user_message,
                            ai_response=final_data.get("content", ""),
                            structured_output=final_data.get("structuredOutput"),
                            runtime_id=message.get(
                                "agentRuntimeId", os.environ.get("agentName", "")
                            ),
                            runtime_version=message.get("runtimeVersion"),
                            endpoint_name=message.get("qualifier", "DEFAULT"),
                        )
                    except Exception as hist_err:
                        logger.warning(f"Failed to save session history: {hist_err}")

                except asyncio.TimeoutError:
                    timeout_msg = (
                        f"Graph execution timed out after "
                        f"{CONFIGURATION.orchestrator.executionTimeoutSeconds}s"
                    )
                    logger.error(timeout_msg)
                    await websocket.send_json({"type": "error", "message": timeout_msg})

                except Exception as err:
                    logger.error(
                        "Failed graph call",
                        extra={"rawErrorMessage": str(err)},
                    )
                    logger.exception(err)
                    await websocket.send_json({"type": "error", "message": str(err)})

            elif msg_type == "heartbeat":
                await websocket.send_json({"type": "heartbeat_ack"})

    except WebSocketDisconnect:
        logger.info("Graph WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Graph WebSocket error: {e}")


# ============================================================
# Entry point
# ============================================================
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=get_uvicorn_host(), port=8080)
