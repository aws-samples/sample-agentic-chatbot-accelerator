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

                    result = await asyncio.wait_for(
                        COMPILED_GRAPH.ainvoke(input_state, config=invoke_config),
                        timeout=timeout_seconds,
                    )

                    logger.info(
                        "Graph completed",
                        extra={
                            "resultKeys": list(result.keys())
                            if isinstance(result, dict)
                            else None,
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
                            runtime_id=message.get(
                                "agentRuntimeId", os.environ.get("agentName", "")
                            ),
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

    host = "0.0.0.0" if os.getenv("DOCKER_CONTAINER") else "127.0.0.1"  # nosec B104
    uvicorn.run(app, host=host, port=8080)
