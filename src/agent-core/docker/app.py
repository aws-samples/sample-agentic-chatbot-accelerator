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
from typing import TYPE_CHECKING

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.agentcore_memory import create_session_manager
from shared.mcp_client import MCPClientManager
from shared.session_history import save_conversation_exchange
from shared.utils import enrich_trajectory
from src.data_source import parse_configuration
from src.factory import create_agent
from src.registry import AVAILABLE_MCPS
from src.structured_output import build_structured_output_model
from strands_evals.mappers import StrandsInMemorySessionMapper

# Trajectory capture imports for evaluation features
# These enable capturing agent reasoning traces for advanced evaluations
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
    WebSocket endpoint for text-based chat with real-time token streaming.

    Protocol:
    - Client sends: {"type": "text_input", "text": "...", "sessionId": "...",
                      "userId": "...", "messageId": "..."}
    - Server sends: {"type": "text_token", "data": "...", "sequenceNumber": N, "runId": "..."}
    - Server sends: {"type": "tool_action", "toolName": "...", "description": "...",
                      "invocationNumber": N}
    - Server sends: {"type": "final_response", "content": "...", "sessionId": "...",
                      "messageId": "...", "references": "...", "reasoningContent": "..."}
    - Server sends: {"type": "error", "message": "..."}
    """
    await websocket.accept()
    logger.info("Text WebSocket connection accepted")

    agent = None
    callbacks = None
    mcp_client_manager: MCPClientManager | None = None
    current_session_id: str | None = None
    structured_output_model = None

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

                # Propagate session ID for observability
                ctx = baggage.set_baggage("session.id", session_id)
                attach(ctx)

                # Clear previous trajectory data if capturing is enabled
                if include_trajectory:
                    memory_exporter.clear()

                # Initialize or reinitialize agent for new session
                if agent is None or current_session_id != session_id:
                    # Clean up previous session's MCP connections if session changed
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

                        # Parse optional session state
                        state_json = message.get("state")
                        state = None
                        if state_json:
                            try:
                                state = (
                                    json.loads(state_json)
                                    if isinstance(state_json, str)
                                    else state_json
                                )
                            except json.JSONDecodeError:
                                logger.warning(
                                    "Malformed JSON in state payload; ignoring session state",
                                    extra={"rawState": state_json},
                                )

                        agent, callbacks = create_agent(
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

                        # Build structured output model from config (if specified)
                        if configuration.structuredOutput:
                            structured_output_model = build_structured_output_model(
                                configuration.structuredOutput
                            )
                            logger.info(
                                "Structured output model built from configuration",
                                extra={
                                    "fields": [
                                        f.model_dump()
                                        for f in configuration.structuredOutput
                                    ]
                                },
                            )
                        else:
                            structured_output_model = None

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
                if callbacks:
                    callbacks.reset_metadata()
                    callbacks._websocket = websocket

                # Hydrate agent state from message on every non-heartbeat message
                state_json = message.get("state")
                if state_json and agent:
                    try:
                        state_data = (
                            json.loads(state_json)
                            if isinstance(state_json, str)
                            else state_json
                        )
                    except json.JSONDecodeError:
                        logger.warning(
                            "Malformed JSON in state payload; skipping state hydration"
                        )
                    else:
                        for key, value in state_data.items():
                            agent.state.set(key, value)
                        logger.info(
                            "Agent state hydrated from payload",
                            extra={"stateKeys": list(state_data.keys())},
                        )

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

                    # Build stream_async kwargs
                    stream_kwargs: dict = {
                        "invocation_state": {
                            "userId": user_id,
                            "sessionId": session_id,
                        },
                    }
                    if structured_output_model is not None:
                        stream_kwargs[
                            "structured_output_model"
                        ] = structured_output_model

                    async for event in agent.stream_async(
                        user_message, **stream_kwargs
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
                            raw_result: AgentResult = event["result"]
                            logger.info(
                                "Agent result event",
                                extra={
                                    "agentResponse": raw_result.to_dict(),
                                    "agentMetrics": raw_result.metrics.accumulated_usage,
                                    "latencyMs": raw_result.metrics.accumulated_metrics.get(
                                        "latencyMs", "??"
                                    ),
                                },
                            )

                            # Extract reasoning content
                            reasoning_content = _extract_reasoning(raw_result)

                            final_data: dict = {
                                "type": "final_response",
                                "content": str(raw_result),
                                "sessionId": session_id,
                                "messageId": message_id,
                            }

                            if reasoning_content:
                                logger.info(
                                    "Model reasoning process",
                                    extra={
                                        "modelReasoning": {"content": reasoning_content}
                                    },
                                )
                                final_data["reasoningContent"] = reasoning_content

                            if callbacks and callbacks.metadata.get("references"):
                                final_data["references"] = json.dumps(
                                    callbacks.metadata["references"]
                                )

                            # Include structured output when available
                            if structured_output_model is not None:
                                try:
                                    structured = raw_result.structured_output
                                    if structured is not None:
                                        final_data[
                                            "structuredOutput"
                                        ] = structured.model_dump_json()
                                        logger.info(
                                            "Structured output included in response",
                                            extra={
                                                "structuredOutput": structured.model_dump()
                                            },
                                        )
                                except Exception as so_err:
                                    logger.warning(
                                        f"Failed to extract structured output: {so_err}",
                                        extra={"error": str(so_err)},
                                    )

                            # Capture trajectory for evaluation features
                            if include_trajectory:
                                try:
                                    finished_spans = (
                                        memory_exporter.get_finished_spans()
                                    )
                                    if finished_spans:
                                        mapper = StrandsInMemorySessionMapper()
                                        trajectory_session = mapper.map_to_session(
                                            finished_spans, session_id=session_id
                                        )
                                        if callbacks and hasattr(
                                            callbacks, "tool_executions"
                                        ):
                                            trajectory_session = enrich_trajectory(
                                                trajectory_session,
                                                callbacks.tool_executions,
                                                logger,
                                            )
                                        final_data["trajectory"] = trajectory_session
                                        logger.info(
                                            "Trajectory captured for evaluation",
                                            extra={"spanCount": len(finished_spans)},
                                        )
                                    else:
                                        logger.warning(
                                            "No spans captured for trajectory"
                                        )
                                except Exception as traj_err:
                                    logger.warning(
                                        f"Failed to capture trajectory: {traj_err}",
                                        extra={"error": str(traj_err)},
                                    )

                            logger.info(
                                "Sending the final answer",
                                extra={
                                    "finalAnswerData": {
                                        k: v
                                        for k, v in final_data.items()
                                        if k != "trajectory"
                                    }
                                },
                            )

                            await websocket.send_json(final_data)

                            # Save conversation to session history (DynamoDB)
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
        logger.info("Text WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Text WebSocket error: {e}")
    finally:
        if mcp_client_manager:
            mcp_client_manager.cleanup_connections()


def _extract_reasoning(raw_result: "AgentResult") -> str:
    """Extract reasoning content from agent result."""
    reasoning = ""
    for item in raw_result.message.get("content", []):
        if isinstance(item, dict) and "reasoningContent" in item:
            r_content = item["reasoningContent"]
            if isinstance(r_content, dict) and "reasoningText" in r_content:
                r_text = r_content["reasoningText"]
                if isinstance(r_text, dict) and "text" in r_text:
                    reasoning += r_text.get("text", "") + "\n"
    return reasoning


# ============================================================
# VOICE MODE: WebSocket endpoint for bidirectional audio
# ============================================================
@app.websocket("/ws/voice")
async def voice_chat(websocket: WebSocket):
    """
    WebSocket endpoint for bidirectional voice streaming via Nova Sonic.

    Protocol (Strands BidiAgent native):
    - Client sends: {"type": "bidi_audio_input", "audio": "<base64>", ...}
    - Server sends: {"type": "bidi_audio_stream", "audio": "<base64>", ...}
    - Server sends: {"type": "bidi_transcript_stream", ...}
    - Server sends: {"type": "bidi_interruption", ...}
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


# ============================================================
# Entry point
# ============================================================
if __name__ == "__main__":
    import uvicorn

    host = "0.0.0.0" if os.getenv("DOCKER_CONTAINER") else "127.0.0.1"
    uvicorn.run(app, host=host, port=8080)
