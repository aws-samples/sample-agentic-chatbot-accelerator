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
from shared.utils import enrich_trajectory, get_uvicorn_host
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

            # Voice mode: if the first message is voice_init, switch to BidiAgent
            if msg_type == "voice_init":
                voice_session_id = message.get("sessionId", str(uuid.uuid4()))
                voice_user_id = message.get("userId", "voice-user")
                logger.info(
                    f"Switching to voice mode (BidiAgent) for session {voice_session_id}"
                )
                await _handle_voice_mode(
                    websocket, logger, voice_session_id, voice_user_id
                )
                return  # voice mode takes over the connection

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
                    callbacks.attach_websocket(websocket)

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
                                    runtime_version=message.get("runtimeVersion"),
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


async def _handle_voice_mode(
    websocket: WebSocket, log, session_id: str = "", user_id: str = "voice-user"
) -> None:
    """Handle voice mode using BidiAgent with Nova Sonic.

    Called when the /ws handler receives a voice_init message.
    Takes over the WebSocket connection for bidirectional audio streaming.
    """
    from shared.bidi_ws_adapter import WebSocketBidiInput, WebSocketBidiOutput
    from strands.experimental.bidi import BidiAgent
    from strands.experimental.bidi.models import BidiNovaSonicModel
    from strands.experimental.bidi.tools import stop_conversation

    configuration = parse_configuration(log)

    # Get model from agent configuration and validate it's a Nova Sonic model
    # (BidiAgent only supports Nova Sonic — other models will fail silently)
    SUPPORTED_SONIC_MODELS = {"amazon.nova-sonic-v1:0", "amazon.nova-2-sonic-v1:0"}
    MODEL_ID = configuration.modelInferenceParameters.modelId
    if MODEL_ID not in SUPPORTED_SONIC_MODELS:
        raise ValueError(
            f"Voice mode requires a Nova Sonic model, but agent is configured with '{MODEL_ID}'. "
            f"Supported models: {SUPPORTED_SONIC_MODELS}"
        )
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

    tools = _initialize_voice_tools(configuration)

    # Initialize MCP clients for voice mode (same as text mode)
    mcp_client_manager = None
    if configuration.mcpServers:
        mcp_client_manager = MCPClientManager(
            mcp_servers=configuration.mcpServers,
            logger=log,
            mcp_registry=AVAILABLE_MCPS,
        )
        mcp_client_manager.init_mcp_clients()
        # Add MCP tools to the tools list
        mcp_tools = mcp_client_manager.load_mcp_tools()
        tools.extend(mcp_tools)
        log.info(f"Loaded {len(mcp_tools)} MCP tools for voice mode")

    # Create session manager if memory is enabled (same as text mode)
    # This persists conversation history across BidiAgent turns and reconnections
    session_manager = None
    if MEMORY_ID and session_id:
        log.info(
            "Creating session manager for voice mode",
            extra={
                "context": {
                    "memoryId": MEMORY_ID,
                    "sessionId": session_id,
                    "userId": user_id,
                }
            },
        )
        session_manager = create_session_manager(
            memory_id=MEMORY_ID,
            session_id=session_id,
            user_id=user_id,
            region_name=AWS_REGION,
        )

    voice_agent = BidiAgent(
        model=sonic_model,
        tools=tools + [stop_conversation],
        system_prompt=configuration.instructions,
        session_manager=session_manager,
    )

    try:
        ws_input = WebSocketBidiInput(websocket)
        ws_output = WebSocketBidiOutput(websocket, session_id=session_id)

        # Loop: BidiAgent.run() completes after each agent response.
        # We keep re-running to accept follow-up questions on the same WebSocket.
        # The loop exits when the user sends bidi_close (raises WebSocketDisconnect).
        while True:
            log.info("Voice: starting BidiAgent turn...")
            await voice_agent.run(
                inputs=[ws_input],  # type: ignore
                outputs=[ws_output],
            )
            log.info("Voice: BidiAgent turn completed, awaiting next user input...")
    except WebSocketDisconnect:
        log.info("Voice WebSocket client disconnected")
    except Exception as e:
        log.error(f"Voice mode error: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            await voice_agent.stop()
        except Exception as exc:
            logger.warning(
                "voice_agent.stop() failed during cleanup",
                extra={"rawErrorMessage": str(exc)},
            )


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

    # Load tools from configuration
    configuration = parse_configuration(logger)
    tools = _initialize_voice_tools(configuration)

    # Initialize MCP clients for voice mode
    mcp_client_manager = None
    if configuration.mcpServers:
        mcp_client_manager = MCPClientManager(
            mcp_servers=configuration.mcpServers,
            logger=logger,
            mcp_registry=AVAILABLE_MCPS,
        )
        mcp_client_manager.init_mcp_clients()
        mcp_tools = mcp_client_manager.load_mcp_tools()
        tools.extend(mcp_tools)
        logger.info(f"Loaded {len(mcp_tools)} MCP tools for voice mode")

    # Create session manager if memory is enabled
    session_manager = None
    if MEMORY_ID:
        session_id = str(uuid.uuid4())
        session_manager = create_session_manager(
            memory_id=MEMORY_ID,
            session_id=session_id,
            user_id="voice-user",
            region_name=AWS_REGION,
        )

    voice_agent = BidiAgent(
        model=sonic_model,
        tools=tools + [stop_conversation],
        system_prompt=configuration.instructions,
        session_manager=session_manager,
    )

    try:
        await websocket.accept()
        logger.info("Voice WebSocket connection accepted")

        # Use WebSocket adapters that implement the BidiInput/BidiOutput protocols
        from shared.bidi_ws_adapter import WebSocketBidiInput, WebSocketBidiOutput

        ws_input = WebSocketBidiInput(websocket)
        ws_output = WebSocketBidiOutput(websocket)

        # Loop: BidiAgent.run() completes after each agent response.
        # We keep re-running to accept follow-up questions on the same WebSocket.
        while True:
            logger.info("Voice: starting BidiAgent turn...")
            await voice_agent.run(
                inputs=[ws_input],  # type: ignore
                outputs=[ws_output],
            )
            logger.info("Voice: BidiAgent turn completed, awaiting next user input...")

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
        except Exception as e:
            logger.error(f"Failed to close the websocket and stop the voice agent: {e}")
            pass


def _initialize_voice_tools(configuration):
    """Initialize tools from agent configuration for voice mode.

    Loads both regular tools (from configuration.tools) and A2A sub-agent
    tools (from configuration.agentsAsTools) so BidiAgent can delegate to
    sub-agents over A2A — the same wiring as text mode.
    """
    from src.factory import build_a2a_subagent_tools
    from src.registry import AVAILABLE_TOOLS

    tools = []
    for tool_name in configuration.tools or []:
        if tool_name in AVAILABLE_TOOLS:
            record = AVAILABLE_TOOLS[tool_name]
            params = (configuration.toolParameters or {}).get(tool_name, {})
            params.pop("invokesSubAgent", None)
            tools.append(record["factory"](**params))

    tools.extend(
        build_a2a_subagent_tools(
            getattr(configuration, "agentsAsTools", []) or [],
            logger,
        )
    )

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

    # Prefer accumulated reasoning (captures ALL model calls); fall back to
    # final-only extraction.
    reasoning_content = (
        callbacks.accumulated_reasoning
        if callbacks and callbacks.accumulated_reasoning
        else _extract_reasoning_content(agent_result)
    )
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

    uvicorn.run(app, host=get_uvicorn_host(), port=8080)
