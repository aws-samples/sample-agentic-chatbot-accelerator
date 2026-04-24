# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import json
import logging
import os
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from shared.agentcore_memory import create_session_manager
from shared.mcp_client import MCPClientManager
from shared.session_history import save_conversation_exchange
from shared.utils import enrich_trajectory
from src.data_source import parse_configuration
from src.factory import create_orchestrator
from src.registry import AVAILABLE_MCPS
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

if TYPE_CHECKING:
    from strands.agent import AgentResult

logger = logging.getLogger("agentcore.app")
logger.setLevel(logging.INFO)

app = FastAPI()

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


# ============================================================
# Health Check (required by AgentCore)
# ============================================================
@app.get("/ping")
async def ping():
    return {"status": "Healthy", "time_of_last_update": int(datetime.now().timestamp())}


# ============================================================
# TEXT MODE: WebSocket endpoint for text streaming
# ============================================================
@app.websocket("/ws")
async def text_chat(websocket: WebSocket):
    """
    WebSocket endpoint for Agents-as-Tools text-based chat with real-time token streaming.
    """
    await websocket.accept()
    logger.info("Agents-as-Tools Text WebSocket connection accepted")

    orchestrator = None
    callbacks = None
    mcp_client_manager: MCPClientManager | None = None
    current_session_id: str | None = None

    telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()
    memory_exporter = telemetry.in_memory_exporter

    try:
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")

            if msg_type == "text_input":
                user_message = message.get("text", "")
                session_id = message.get("sessionId", str(uuid.uuid4()))
                user_id = message.get("userId", "")
                message_id = message.get("messageId", str(uuid.uuid4()))
                include_trajectory = message.get("includeTrajectory", False)

                if not user_id:
                    await websocket.send_json(
                        {"type": "error", "message": "User identifier must be present"}
                    )
                    continue

                if include_trajectory:
                    memory_exporter.clear()

                # Parse optional session state from message (stringified JSON)
                state_json = message.get("state")
                state = (
                    json.loads(state_json)
                    if state_json and isinstance(state_json, str)
                    else state_json
                )

                # Initialize orchestrator once per session (or if session changes)
                if orchestrator is None or current_session_id != session_id:
                    if mcp_client_manager and current_session_id != session_id:
                        mcp_client_manager.cleanup_connections()

                    logger.info(
                        "Initializing agent for session",
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
                            f"Agent configuration: {configuration.model_dump_json()}"
                        )

                        # Init MCP Clients if provided in agent config
                        if configuration.mcpServers:
                            mcp_client_manager = MCPClientManager(
                                mcp_servers=configuration.mcpServers,
                                logger=logger,
                                mcp_registry=AVAILABLE_MCPS,
                            )
                            mcp_client_manager.init_mcp_clients()

                        # Create session manager if memory is enabled
                        session_manager = None
                        if MEMORY_ID and session_id:
                            logger.info(
                                "Creating session manager with AgentCore Memory",
                                extra={"context": {"memoryId": MEMORY_ID}},
                            )
                            session_manager = create_session_manager(
                                memory_id=MEMORY_ID,
                                session_id=session_id,
                                user_id=user_id,
                                region_name=AWS_REGION,
                            )

                        # Trace attributes for trajectory capture
                        trace_attrs = None
                        if include_trajectory:
                            trace_attrs = {
                                "gen_ai.conversation.id": session_id,
                                "session.id": session_id,
                            }

                        orchestrator, callbacks = create_orchestrator(
                            configuration,
                            logger,
                            session_id,
                            user_id,
                            mcp_client_manager,
                            session_manager,
                            trace_attributes=trace_attrs,
                            state=state,
                        )
                        current_session_id = session_id

                    except Exception as err:
                        logger.error(
                            "Failed to initialize agent",
                            extra={"rawErrorMessage": str(err)},
                        )
                        if mcp_client_manager:
                            mcp_client_manager.cleanup_connections()
                        await websocket.send_json(
                            {"type": "error", "message": str(err)}
                        )
                        continue

                # Reset metadata for new turn and pass WebSocket reference
                if include_trajectory:
                    memory_exporter.clear()
                if callbacks:
                    callbacks.reset_metadata()
                    callbacks._websocket = websocket

                logger.info(
                    "Calling agent with user message and context",
                    extra={
                        "prompt": user_message,
                        "context": {
                            "sessionId": session_id,
                            "userId": user_id,
                        },
                    },
                )

                # Stream response tokens
                try:
                    run_id = str(uuid.uuid4())
                    token_id = 0

                    async for event in orchestrator.stream_async(
                        user_message,
                        invocation_state={
                            "userId": user_id,
                            "sessionId": session_id,
                        },
                    ):
                        if "data" in event:
                            await websocket.send_json(
                                {
                                    "type": "text_token",
                                    "data": event["data"],
                                    "sequenceNumber": token_id,
                                    "runId": f"t-{run_id}",
                                }
                            )
                            token_id += 1

                        elif "result" in event:
                            final_data = _build_final_response(
                                session_id,
                                message_id,
                                event["result"],
                                include_trajectory,
                                callbacks,
                                memory_exporter,
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
                                    references=final_data.get("references"),
                                    reasoning_content=final_data.get(
                                        "reasoningContent"
                                    ),
                                    structured_output=final_data.get(
                                        "structuredOutput"
                                    ),
                                    runtime_id=message.get(
                                        "agentRuntimeId",
                                        os.environ.get("agentName", ""),
                                    ),
                                    endpoint_name=message.get("qualifier", "DEFAULT"),
                                )
                            except Exception as hist_err:
                                logger.warning(
                                    f"Failed to save session history: {hist_err}"
                                )

                except Exception as err:
                    logger.exception(f"Error streaming response: {err}")
                    await websocket.send_json({"type": "error", "message": str(err)})

            elif msg_type == "heartbeat":
                await websocket.send_json({"type": "heartbeat_ack"})

    except WebSocketDisconnect:
        logger.info("Agents-as-Tools WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Agents-as-Tools WebSocket error: {e}")
    finally:
        if mcp_client_manager:
            mcp_client_manager.cleanup_connections()


# ============================================================
# VOICE MODE: WebSocket endpoint for bidirectional audio
# ============================================================
@app.websocket("/ws/voice")
async def voice_chat(websocket: WebSocket):
    """
    WebSocket endpoint for bidirectional voice streaming via Nova Sonic.
    Agents-as-Tools supports voice because the orchestrator is a single Agent
    with sub-agents invoked as tools.
    """
    from strands.experimental.bidi import BidiAgent
    from strands.experimental.bidi.models import BidiNovaSonicModel
    from strands.experimental.bidi.tools import stop_conversation

    MODEL_ID = os.getenv("VOICE_MODEL_ID", "amazon.nova-2-sonic-v1:0")
    BEDROCK_REGION = os.getenv("BEDROCK_REGION", AWS_REGION or "us-east-1")

    sonic_model = BidiNovaSonicModel(
        model_id=MODEL_ID,
        provider_config={
            "audio": {
                "voice": "tiffany",
                "input_rate": 16000,
                "output_rate": 16000,
                "channels": 1,
                "format": "pcm",
            },
            "inference": {},
        },
        client_config={"region": BEDROCK_REGION},
    )

    configuration = parse_configuration(logger)
    tools = _initialize_voice_tools(configuration)

    voice_agent = BidiAgent(
        model=sonic_model,
        tools=tools + [stop_conversation],
        system_prompt=configuration.instructions,
    )

    try:
        await websocket.accept()
        logger.info("Voice WebSocket connection accepted")

        await voice_agent.run(
            inputs=[websocket.receive_json],
            outputs=[websocket.send_json],
        )
    except WebSocketDisconnect:
        logger.info("Voice WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Voice WebSocket error: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            await websocket.close()
            await voice_agent.stop()
        except Exception:
            pass


def _initialize_voice_tools(configuration):
    """Initialize tools from agent configuration for voice mode."""
    from src.registry import AVAILABLE_TOOLS

    tools = []
    for tool_name in configuration.tools:
        if tool_name in AVAILABLE_TOOLS:
            record = AVAILABLE_TOOLS[tool_name]
            params = configuration.toolParameters.get(tool_name, {})
            params.pop("invokesSubAgent", None)
            tools.append(record["factory"](**params))
    return tools


# --- private helpers ---


def _extract_reasoning_content(agent_result: "AgentResult") -> str:
    """Extract concatenated reasoning text from an agent result message."""
    parts: list[str] = []
    for item in agent_result.message.get("content", []):
        if not isinstance(item, dict) or "reasoningContent" not in item:
            continue
        r_content = item["reasoningContent"]
        if not isinstance(r_content, dict) or "reasoningText" not in r_content:
            continue
        r_text = r_content["reasoningText"]
        if isinstance(r_text, dict) and "text" in r_text:
            parts.append(r_text["text"])
    return "\n".join(parts)


def _capture_trajectory(
    session_id: str, callbacks: Any, memory_exporter: Any
) -> Any | None:
    """Capture an evaluation trajectory from in-memory OpenTelemetry spans."""
    try:
        finished_spans = memory_exporter.get_finished_spans()
        if not finished_spans:
            logger.warning("No spans captured for trajectory")
            return None

        mapper = StrandsInMemorySessionMapper()
        trajectory_session = mapper.map_to_session(
            finished_spans, session_id=session_id
        )

        if callbacks and hasattr(callbacks, "tool_executions"):
            trajectory_session = enrich_trajectory(
                trajectory_session,
                callbacks.tool_executions,
                logger,
            )

        logger.info(
            "Trajectory captured for evaluation",
            extra={"spanCount": len(finished_spans)},
        )
        return trajectory_session
    except Exception as traj_err:
        logger.warning(
            f"Failed to capture trajectory: {traj_err}",
            extra={"error": str(traj_err)},
        )
        return None


def _build_final_response(
    session_id: str,
    message_id: str | None,
    agent_result: "AgentResult",
    include_trajectory: bool,
    callbacks: Any,
    memory_exporter: Any,
) -> dict:
    """Build a final_response WebSocket message from an agent result."""
    logger.info(
        "Agent result event",
        extra={
            "agentResponse": agent_result.to_dict(),
            "agentMetrics": agent_result.metrics.accumulated_usage,
            "latencyMs": agent_result.metrics.accumulated_metrics.get(
                "latencyMs", "??"
            ),
        },
    )

    final_data: dict = {
        "type": "final_response",
        "content": str(agent_result),
        "sessionId": session_id,
        "messageId": message_id,
    }

    # Reasoning content
    reasoning_content = _extract_reasoning_content(agent_result)
    if reasoning_content:
        logger.info(
            "Model reasoning process",
            extra={"modelReasoning": {"content": reasoning_content}},
        )
        final_data["reasoningContent"] = reasoning_content

    # References from callbacks
    if callbacks and callbacks.metadata.get("references"):
        final_data["references"] = json.dumps(callbacks.metadata["references"])

    # Trajectory for evaluation
    if include_trajectory:
        trajectory = _capture_trajectory(session_id, callbacks, memory_exporter)
        if trajectory is not None:
            final_data["trajectory"] = trajectory

    logger.info(
        "Sending the final answer",
        extra={
            "finalAnswerData": {
                k: v for k, v in final_data.items() if k != "trajectory"
            }
        },
    )

    return final_data


# --- entry point ---

if __name__ == "__main__":
    import uvicorn

    host = "0.0.0.0" if os.getenv("DOCKER_CONTAINER") else "127.0.0.1"
    uvicorn.run(app, host=host, port=8080)
