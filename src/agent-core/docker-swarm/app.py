# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import logging
import os
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.mcp_client import MCPClientManager
from shared.session_history import save_conversation_exchange
from src.data_source import parse_configuration
from src.factory import create_swarm
from src.registry import AVAILABLE_MCPS
from strands import Agent
from strands.multiagent import Swarm
from strands_evals.extractors import swarm_extractor

logger = logging.getLogger("agentcore.app")
logger.setLevel(logging.INFO)

app = FastAPI()

# Global swarm variable - initialized once per session
SWARM: Swarm | None = None
AGENTS: dict[str, Agent] = {}
CURRENT_SESSION_ID: str | None = None
CALLBACKS = None
MCP_CLIENT_MANAGER: MCPClientManager | None = None

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
async def swarm_text_chat(websocket: WebSocket):
    """
    Text WebSocket for Swarm — sends complete response (no token streaming).
    Swarm execution is blocking; voice mode is NOT supported.
    """
    global SWARM, AGENTS, CURRENT_SESSION_ID, CALLBACKS, MCP_CLIENT_MANAGER

    await websocket.accept()
    logger.info("Swarm Text WebSocket connection accepted")

    try:
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")

            if msg_type == "text_input":
                user_message = message.get("text", "Hello")
                user_id = message.get("userId")
                message_id = message.get("messageId")
                session_id = message.get("sessionId")

                # Trajectory capture flag for evaluation features
                include_trajectory = message.get("includeTrajectory", False)

                # Propagate session ID for observability
                ctx = baggage.set_baggage("session.id", session_id)
                attach(ctx)

                # Initialize swarm once per session (or if session changes)
                if SWARM is None or CURRENT_SESSION_ID != session_id:
                    # Clean up previous session's MCP connections if session changed
                    if MCP_CLIENT_MANAGER and CURRENT_SESSION_ID != session_id:
                        MCP_CLIENT_MANAGER.cleanup_connections()

                    logger.info(
                        "Initializing swarm for session",
                        extra={
                            "context": {
                                "sessionId": session_id,
                                "userId": user_id,
                            }
                        },
                    )

                    try:
                        configuration = parse_configuration(logger)
                        logger.info(
                            "Swarm configuration loaded",
                            extra={
                                "agentCount": len(configuration.agents),
                                "entryAgent": configuration.entryAgent,
                            },
                        )

                        # Collect all MCP servers from all agents
                        all_mcp_servers = set()
                        for agent_def in configuration.agents:
                            all_mcp_servers.update(agent_def.mcpServers)

                        # Init MCP Clients if any agent has MCP servers configured
                        if all_mcp_servers:
                            MCP_CLIENT_MANAGER = MCPClientManager(
                                mcp_servers=list(all_mcp_servers),
                                logger=logger,
                                mcp_registry=AVAILABLE_MCPS,
                            )
                            MCP_CLIENT_MANAGER.init_mcp_clients()

                        # Session persistence not yet supported for Swarm agents
                        if MEMORY_ID and session_id:
                            logger.warning(
                                "Memory/session persistence is not yet supported for Swarm agents. "
                                "Skipping session manager creation.",
                                extra={"context": {"memoryId": MEMORY_ID}},
                            )

                        # Parse optional session state from message
                        state_json = message.get("state")
                        state = (
                            json.loads(state_json)
                            if state_json and isinstance(state_json, str)
                            else state_json
                        )

                        SWARM, CALLBACKS, AGENTS = create_swarm(
                            configuration,
                            logger,
                            session_id=session_id,
                            user_id=user_id,
                            mcp_client_manager=MCP_CLIENT_MANAGER,
                            session_manager=None,
                            state=state,
                        )
                        CURRENT_SESSION_ID = session_id

                        logger.info(
                            "Swarm initialized successfully",
                            extra={
                                "agentNames": list(AGENTS.keys()),
                                "entryAgent": configuration.entryAgent,
                            },
                        )

                    except Exception as err:
                        logger.error(
                            "Failed to initialize swarm",
                            extra={"rawErrorMessage": str(err)},
                        )
                        if MCP_CLIENT_MANAGER:
                            MCP_CLIENT_MANAGER.cleanup_connections()
                        await websocket.send_json(
                            {"type": "error", "message": str(err)}
                        )
                        continue

                # Clean up metadata from previous message in the same session
                if CALLBACKS:
                    CALLBACKS.reset_metadata()

                logger.info(
                    "Calling swarm with user message and context",
                    extra={
                        "prompt": user_message,
                        "context": {
                            "sessionId": session_id,
                            "userId": user_id,
                        },
                    },
                )

                try:
                    result = SWARM(user_message)

                    logger.info(
                        "Swarm completed",
                        extra={
                            "resultMetadata": {
                                "status": result.status.value,
                                "nodeHistory": [
                                    node.node_id for node in result.node_history
                                ],
                                "totalIterations": result.execution_count,
                                "executionTime": result.execution_time,
                                "tokenUsage": result.accumulated_usage,
                            }
                        },
                    )

                    reasoning_content = [
                        "# Intermediate Swarm node results",
                    ]
                    for agent_call_order, node in enumerate(result.node_history[:-1]):
                        node_res = str(result.results[node.node_id].result)
                        reasoning_content.append(
                            f"## Agent {agent_call_order + 1} [{node.node_id}]"
                        )
                        reasoning_content.append(node_res)

                    final_data: dict = {
                        "type": "final_response",
                        "content": str(
                            result.results[result.node_history[-1].node_id].result
                        ),
                        "sessionId": session_id,
                        "messageId": message_id,
                    }
                    if len(reasoning_content) > 1:
                        final_data["reasoningContent"] = "\n\n".join(reasoning_content)

                    # Capture trajectory and interactions for evaluation features
                    if include_trajectory:
                        try:
                            trajectory = [node.node_id for node in result.node_history]
                            interaction_info = (
                                swarm_extractor.extract_swarm_interactions(result)
                            )

                            final_data["trajectory"] = {
                                "session_id": session_id,
                                "trajectory": trajectory,
                                "interactions": interaction_info,
                                "status": result.status.value,
                                "execution_count": result.execution_count,
                                "execution_time": result.execution_time,
                            }

                            logger.info(
                                "Trajectory and interactions captured for evaluation",
                                extra={
                                    "trajectory": trajectory,
                                    "interactionCount": len(interaction_info)
                                    if interaction_info
                                    else 0,
                                },
                            )
                        except Exception as traj_err:
                            logger.warning(
                                f"Failed to capture trajectory/interactions: {traj_err}",
                                extra={"error": str(traj_err)},
                            )
                            final_data["trajectory"] = {
                                "session_id": session_id,
                                "trajectory": [],
                                "interactions": [],
                            }

                    await websocket.send_json(final_data)

                    # Save conversation to session history
                    try:
                        save_conversation_exchange(
                            session_id=session_id,
                            user_id=user_id,
                            message_id=message_id,
                            user_message=user_message,
                            ai_response=final_data.get("content", ""),
                            reasoning_content=final_data.get("reasoningContent"),
                            runtime_id=message.get(
                                "agentRuntimeId", os.environ.get("agentName", "")
                            ),
                            endpoint_name=message.get("qualifier", "DEFAULT"),
                        )
                    except Exception as hist_err:
                        logger.warning(f"Failed to save session history: {hist_err}")

                except Exception as err:
                    logger.error(
                        "Failed swarm call",
                        extra={"rawErrorMessage": str(err)},
                    )
                    logger.exception(err)
                    await websocket.send_json({"type": "error", "message": str(err)})

            elif msg_type == "heartbeat":
                await websocket.send_json({"type": "heartbeat_ack"})

    except WebSocketDisconnect:
        logger.info("Swarm WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Swarm WebSocket error: {e}")


# ============================================================
# Entry point
# ============================================================
if __name__ == "__main__":
    import uvicorn

    host = "0.0.0.0" if os.getenv("DOCKER_CONTAINER") else "127.0.0.1"
    uvicorn.run(app, host=host, port=8080)
