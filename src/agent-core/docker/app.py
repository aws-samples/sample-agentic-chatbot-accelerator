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

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.agentcore_a2a import (
    A2A_PORT,
    SERVER_PROTOCOL_A2A,
    SERVER_PROTOCOL_HTTP,
)
from shared.agentcore_memory import create_session_manager
from shared.mcp_client import MCPClientManager
from shared.session_history import save_conversation_exchange
from shared.utils import enrich_trajectory
from src.data_source import parse_configuration
from src.factory import create_agent
from src.registry import AVAILABLE_MCPS
from src.structured_output import build_structured_output_model
from starlette.responses import StreamingResponse
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
# INVOCATIONS: HTTP POST endpoint for agent-to-agent calls
# ============================================================

# Module-level state for /invocations. AgentCore allocates one microVM per
# runtimeSessionId, so each container instance serves exactly one session
# for its lifetime — the agent is built once on first invocation and reused.
_inv_agent = None
_inv_mcp_manager: MCPClientManager | None = None
_inv_structured_output_model = None
_inv_session_id: str | None = None


@app.post("/invocations")
async def invocations(request: Request):
    """HTTP POST endpoint for evaluation-driven invocations.

    Called by the evaluation executor (``src/api/functions/evaluation-executor``)
    via ``bedrock-agentcore.invoke_agent_runtime``. Returns an SSE stream;
    consumers parse ``data: {action: "final_response", data: {...}}`` events.

    Request body (JSON):
        - prompt (str): The user query.
        - userId (str, optional): Defaults to ``"evaluator"``.
        - sessionId (str, optional): Auto-generated if absent.
    """
    global _inv_agent, _inv_mcp_manager, _inv_structured_output_model, _inv_session_id

    body = await request.json()
    prompt = body.get("prompt", "")
    user_id = body.get("userId", "evaluator")
    session_id = body.get("sessionId", str(uuid.uuid4()))

    logger.info(
        "Invocation received",
        extra={"prompt": prompt, "userId": user_id, "sessionId": session_id},
    )

    # The microVM-per-session invariant means we should only ever see one
    # body.sessionId for the lifetime of this container. If a caller sends a
    # different one, the cached agent's session_manager is bound to the wrong
    # session — fail loudly rather than route memory writes to the wrong place.
    if _inv_agent is not None and _inv_session_id != session_id:
        err_msg = (
            f"sessionId mismatch on /invocations: container is bound to "
            f"{_inv_session_id!r} but received {session_id!r}"
        )
        logger.error(err_msg)
        error_event = json.dumps({"error": err_msg})

        async def _mismatch_stream():
            yield f"data: {error_event}\n\n"

        return StreamingResponse(_mismatch_stream(), media_type="text/event-stream")

    if _inv_agent is None:
        try:
            configuration = parse_configuration(logger)

            if configuration.mcpServers:
                _inv_mcp_manager = MCPClientManager(
                    mcp_servers=configuration.mcpServers,
                    logger=logger,
                    mcp_registry=AVAILABLE_MCPS,
                )
                _inv_mcp_manager.init_mcp_clients()

            session_manager = None
            if MEMORY_ID and session_id:
                session_manager = create_session_manager(
                    memory_id=MEMORY_ID,
                    session_id=session_id,
                    user_id=user_id,
                    region_name=AWS_REGION,
                )

            _inv_agent, _ = create_agent(
                configuration,
                logger,
                session_id,
                user_id,
                _inv_mcp_manager,
                session_manager,
            )
            _inv_session_id = session_id

            _inv_structured_output_model = (
                build_structured_output_model(configuration.structuredOutput)
                if configuration.structuredOutput
                else None
            )

        except Exception as err:
            logger.error(
                "Failed to initialize agent for /invocations", extra={"error": str(err)}
            )
            # Release MCP clients opened before the failure so a retry doesn't
            # leak the previous attempt's connections.
            if _inv_mcp_manager is not None:
                try:
                    _inv_mcp_manager.cleanup_connections()
                except Exception as cleanup_err:
                    logger.warning(
                        "MCP cleanup failed after init error",
                        extra={"rawErrorMessage": str(cleanup_err)},
                    )
                _inv_mcp_manager = None
            error_event = json.dumps({"error": str(err)})

            async def _error_stream():
                yield f"data: {error_event}\n\n"

            return StreamingResponse(_error_stream(), media_type="text/event-stream")

    async def _sse_generator():
        try:
            _stream_kwargs: dict = {
                "invocation_state": {"userId": user_id, "sessionId": session_id},
            }
            if _inv_structured_output_model is not None:
                _stream_kwargs["structured_output_model"] = _inv_structured_output_model

            async for event in _inv_agent.stream_async(  # type: ignore
                prompt,
                **_stream_kwargs,
            ):
                if "data" in event:
                    # Stream tokens to keep the connection alive (prevents read timeout)
                    token_event = json.dumps(
                        {
                            "action": "on_new_llm_token",
                            "data": {"token": {"value": event["data"]}},
                        }
                    )
                    yield f"data: {token_event}\n\n"

                elif "result" in event:
                    raw_result = event["result"]
                    content = str(raw_result)
                    logger.info(
                        "Invocation complete",
                        extra={"responseLength": len(content), "sessionId": session_id},
                    )
                    final_data = {"content": content}

                    # Include structured output when available (for graph sub-agent invocation)
                    if (
                        hasattr(raw_result, "structured_output")
                        and raw_result.structured_output is not None
                    ):
                        try:
                            final_data[
                                "structuredOutput"
                            ] = raw_result.structured_output.model_dump_json()
                        except Exception as exc:
                            logger.warning(
                                "structured_output serialization failed",
                                extra={"rawErrorMessage": str(exc)},
                            )

                    final_event = json.dumps(
                        {"action": "final_response", "data": final_data}
                    )
                    yield f"data: {final_event}\n\n"

        except Exception as err:
            logger.exception(f"Invocation error: {err}")
            error_event = json.dumps({"error": str(err)})
            yield f"data: {error_event}\n\n"

    return StreamingResponse(_sse_generator(), media_type="text/event-stream")


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
                    callbacks.attach_websocket(websocket)

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

                            # Prefer accumulated reasoning (captures ALL model
                            # calls); fall back to final-only extraction.
                            reasoning_content = (
                                callbacks.accumulated_reasoning
                                if callbacks and callbacks.accumulated_reasoning
                                else _extract_reasoning(raw_result)
                            )

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
                                            finished_spans, session_id=session_id  # type: ignore
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
            "inference": {
                "max_tokens": configuration.modelInferenceParameters.parameters.maxTokens,
                "temperature": configuration.modelInferenceParameters.parameters.temperature,
            },
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

    # TODO: Add AgentSkills plugin support for voice mode once BidiAgent supports
    # the `plugins` parameter. Monitor Strands SDK releases for BidiAgent plugin support.
    # See: https://strandsagents.com/docs/user-guide/concepts/plugins/skills/

    voice_agent = BidiAgent(
        model=sonic_model,
        tools=tools + [stop_conversation],
        system_prompt=configuration.instructions,
        session_manager=session_manager,
    )

    # NOTE: BeforeToolCallEvent/AfterToolCallEvent are standard Agent hooks and do NOT
    # fire in BidiAgent. Tool descriptions for voice mode are sent directly by
    # WebSocketBidiOutput as a raw tool_description WS event (no LLM rephrasing) when
    # it detects a ToolUseStreamEvent in the output stream.

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
# A2A protocol mode
# ============================================================


def _build_a2a_app() -> FastAPI:
    """Build the FastAPI app served when this container runs in A2A protocol mode.

    AgentCore Runtime allocates one microVM per ``runtimeSessionId``. The agent
    we build here therefore lives exactly as long as the session does — when
    a new session arrives, AgentCore spins up a new microVM and this function
    runs again from scratch. So a single eagerly-built agent at startup is
    *the* per-session agent for this microVM, with no need for lazy
    construction or a session->agent cache.

    Sub-agents reached over A2A are treated as stateless workers: no
    AgentCore Memory is wired in (sessions in the orchestrator are the
    user-facing notion of conversation state). The ``session_id`` and
    ``user_id`` passed into ``create_agent`` are therefore observability-only
    placeholders — they flow into log lines and SNS tool-event metadata but
    are not used for memory scoping.
    """
    from strands.multiagent.a2a import A2AServer

    a2a_app = FastAPI(title="AgentCore A2A Server")

    @a2a_app.get("/ping")
    async def a2a_ping():
        """Health check used by AgentCore container probes."""
        return {
            "status": "Healthy",
            "time_of_last_update": int(datetime.now().timestamp()),
        }

    configuration = parse_configuration(logger)
    logger.info(
        "Initializing A2A sub-agent",
        extra={"agentName": os.environ.get("agentName", "")},
    )

    mcp_client_manager: MCPClientManager | None = None
    if configuration.mcpServers:
        mcp_client_manager = MCPClientManager(
            mcp_servers=configuration.mcpServers,
            logger=logger,
            mcp_registry=AVAILABLE_MCPS,
        )
        mcp_client_manager.init_mcp_clients()

    agent, _callbacks = create_agent(
        configuration,
        logger,
        session_id="a2a",
        user_id="a2a",
        mcp_client_manager=mcp_client_manager,
        session_manager=None,
    )

    # Populate the agent card. The orchestrator's A2A client reads `description`
    # to build the tool description its LLM sees when deciding whether to
    # delegate, so the operator-authored capability blurb (configuration.description)
    # is the right value here. Strands' A2AServer rejects empty descriptions —
    # fall back to a generic one only if the operator left the field blank.
    agent_name = os.environ.get("agentName", "agent")
    agent.name = agent_name
    agent.description = (
        configuration.description
        if configuration.description
        else f"AgentCore sub-agent {agent_name}"
    )

    # AgentCore auto-populates AGENTCORE_RUNTIME_URL with the public invocation
    # URL of this runtime (e.g. https://bedrock-agentcore.<region>.amazonaws.com
    # /runtimes/<urlencoded-arn>/invocations/). Surfacing it as the agent
    # card's `url` ensures A2A clients post `message/send` back through the
    # AgentCore proxy instead of trying to reach 0.0.0.0:9000 directly.
    http_url = os.environ.get("AGENTCORE_RUNTIME_URL")

    a2a_server = A2AServer(
        agent=agent,
        host="0.0.0.0",  # nosec B104 — required by AgentCore container networking
        port=A2A_PORT,
        http_url=http_url,
        serve_at_root=True,
    )

    # Swap the default executor for one that surfaces structured output as an
    # A2A DataPart. Graph nodes need the structured payload to merge into
    # shared state — the stock executor only emits TextPart artifacts, so
    # without this graph A2A calls would lose any structured_output the
    # sub-agent produces. Done in-place because A2AServer doesn't accept a
    # custom executor on the constructor.
    if configuration.structuredOutput:
        from shared.a2a_executor import StructuredOutputA2AExecutor

        so_model = build_structured_output_model(configuration.structuredOutput)
        a2a_server.request_handler.agent_executor = StructuredOutputA2AExecutor(
            agent, structured_output_model=so_model
        )
        logger.info(
            "A2A executor patched with structured-output support",
            extra={"fields": [f.model_dump() for f in configuration.structuredOutput]},
        )

    a2a_app.mount("/", a2a_server.to_fastapi_app())
    return a2a_app


# ============================================================
# Module-level apps
# ============================================================
# `app` (FastAPI defined above) is the HTTP-protocol entry. `a2a_app` is its
# A2A-protocol sibling — built lazily only when the runtime is in A2A mode so
# HTTP twins don't pay the A2A startup cost. The container's entrypoint.sh
# picks one of these symbols (`app:app` vs `app:a2a_app`) based on the
# `agentcoreServerProtocol` env var.
_SERVER_PROTOCOL = os.environ.get(
    "agentcoreServerProtocol", SERVER_PROTOCOL_HTTP
).upper()
a2a_app: FastAPI | None = (
    _build_a2a_app() if _SERVER_PROTOCOL == SERVER_PROTOCOL_A2A else None
)
