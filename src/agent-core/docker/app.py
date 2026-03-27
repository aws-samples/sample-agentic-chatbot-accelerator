# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.agentcore_memory import create_session_manager
from shared.mcp_client import MCPClientManager
from shared.utils import enrich_trajectory
from src.data_source import parse_configuration
from src.factory import create_agent
from src.registry import AVAILABLE_MCPS
from src.structured_output import build_structured_output_model
from src.types import ChatbotAction
from strands_evals.mappers import StrandsInMemorySessionMapper

# Trajectory capture imports for evaluation features
# These enable capturing agent reasoning traces for advanced evaluations
from strands_evals.telemetry import StrandsEvalsTelemetry

if TYPE_CHECKING:
    from strands.agent import AgentResult


logger = logging.getLogger("bedrock_agentcore.app")
logger.setLevel(logging.INFO)

app = BedrockAgentCoreApp()

# Global agent variable - initialized once per session
AGENT = None
CURRENT_SESSION_ID: str | None = None
CALLBACKS = None
MCP_CLIENT_MANAGER: MCPClientManager | None = None
STRUCTURED_OUTPUT_MODEL = (
    None  # Pydantic model for structured output (built from config)
)

TELEMETRY = StrandsEvalsTelemetry().setup_in_memory_exporter()
MEMORY_EXPORTER = TELEMETRY.in_memory_exporter

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


@app.entrypoint
async def invoke(payload, context: RequestContext):
    """Process user input and return a response"""
    global AGENT, CURRENT_SESSION_ID, CALLBACKS, MCP_CLIENT_MANAGER, STRUCTURED_OUTPUT_MODEL

    user_message = payload.get("prompt", "Hello")
    user_id = payload.get("userId")
    message_id = payload.get("messageId")
    session_id = context.session_id

    # Trajectory capture flag for evaluation features
    # When true, agent execution traces are captured and returned
    include_trajectory = payload.get("includeTrajectory", False)

    # Propagate session ID for observability
    ctx = baggage.set_baggage("session.id", session_id)
    attach(ctx)

    # Clear previous trajectory data if capturing is enabled
    if include_trajectory:
        MEMORY_EXPORTER.clear()
        logger.info("Trajectory capture enabled for this request")

    # Initialize agent once per session (or if session changes) (should not happen)
    if AGENT is None or CURRENT_SESSION_ID != session_id:
        # initialize a new agent once for each runtime container session.
        # conversation state will be persisted in both local memory
        # and remote agentcore memory. for resumed sessions,
        # AgentCoreMemorySessionManager will rehydrate state from agentcore memory

        # Clean up previous session's MCP connections if session changed (should not happen)
        if MCP_CLIENT_MANAGER and CURRENT_SESSION_ID != session_id:
            MCP_CLIENT_MANAGER.cleanup_connections()

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
            logger.info(f"Agent configuration: {configuration.model_dump_json()}")

            # Init MCP Clients if provided in agent config
            if configuration.mcpServers:
                MCP_CLIENT_MANAGER = MCPClientManager(
                    mcp_servers=configuration.mcpServers,
                    logger=logger,
                    mcp_registry=AVAILABLE_MCPS,
                )
                MCP_CLIENT_MANAGER.init_mcp_clients()

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
            # These link OpenTelemetry spans to this session for evaluation
            trace_attrs = None
            if include_trajectory:
                trace_attrs = {
                    "gen_ai.conversation.id": session_id,
                    "session.id": session_id,
                }
                logger.info(
                    "Agent configured with trace attributes for trajectory capture"
                )

            # Parse optional session state from payload (stringified JSON)
            state_json = payload.get("state")
            state = None
            if state_json:
                try:
                    state = json.loads(state_json)
                except json.JSONDecodeError:
                    logger.warning(
                        "Malformed JSON in state payload; ignoring session state",
                        extra={"rawState": state_json},
                    )

            AGENT, CALLBACKS = create_agent(
                configuration,
                logger,
                session_id,  # type: ignore
                user_id,
                MCP_CLIENT_MANAGER,
                session_manager,
                trace_attributes=trace_attrs,  # type: ignore
                state=state,
            )
            CURRENT_SESSION_ID = session_id

            # Build structured output model from config (if specified)
            # When present, the agent's final response will be parsed into
            # this Pydantic model, similar to passing structured_output_model
            # directly in the notebook example.
            if configuration.structuredOutput:
                STRUCTURED_OUTPUT_MODEL = build_structured_output_model(
                    configuration.structuredOutput
                )
                logger.info(
                    "Structured output model built from configuration",
                    extra={
                        "fields": [
                            f.model_dump() for f in configuration.structuredOutput
                        ]
                    },
                )
            else:
                STRUCTURED_OUTPUT_MODEL = None

        except Exception as err:
            logger.error(
                "Failed to initialize agent", extra={"rawErrorMessage": str(err)}
            )
            if MCP_CLIENT_MANAGER:
                MCP_CLIENT_MANAGER.cleanup_connections()  # cleanup mcp connection if agent creation fails
            raise err

    # Clean up metadata originated by the agent from a previous message in the same session
    if CALLBACKS:
        CALLBACKS.reset_metadata()

    if payload.get("isHeartbeat"):
        logger.info("Exiting function because the payload is only a heartbeat")
        return

    # Hydrate agent state from payload on every non-heartbeat message.
    state_json = payload.get("state")
    if state_json and AGENT:
        try:
            state_data = json.loads(state_json)
        except json.JSONDecodeError:
            logger.warning(
                "Malformed JSON in state payload; skipping state hydration",
                extra={"rawState": state_json},
            )
        else:
            for key, value in state_data.items():
                AGENT.state.set(key, value)
            logger.info(
                "Agent state hydrated from payload",
                extra={"stateKeys": list(state_data.keys())},
            )

    logger.info(
        "Calling agent with user message and context",
        extra={
            "prompt": user_message,
            "context": {"sessionId": context.session_id, "userId": user_id},
        },
    )

    try:
        run_id = str(uuid.uuid4())
        token_id = 0
        # Build stream_async kwargs — only include structured_output_model
        # when the configuration defines one (keeps backwards compatibility)
        stream_kwargs: dict = {
            "invocation_state": {"userId": user_id, "sessionId": session_id},
        }
        if STRUCTURED_OUTPUT_MODEL is not None:
            stream_kwargs["structured_output_model"] = STRUCTURED_OUTPUT_MODEL

        async for event in AGENT.stream_async(user_message, **stream_kwargs):
            if "data" in event:
                data_to_send = {
                    "action": ChatbotAction.ON_NEW_LLM_TOKEN.value,
                    "userId": user_id,
                    "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
                    "type": "text",
                    "framework": "AGENT_CORE",
                    "data": {
                        "sessionId": session_id,
                        "token": {
                            "runId": f"t-{run_id}",
                            "sequenceNumber": token_id,
                            "value": event["data"],
                        },
                    },
                }
                logger.debug("Sending a token", extra={"dataToSend": data_to_send})
                yield data_to_send
                token_id += 1

            elif "result" in event:
                raw_final_response: AgentResult = event["result"]
                logger.info(
                    "Agent result event",
                    extra={
                        "agentResponse": raw_final_response.to_dict(),
                        "agentMetrics": raw_final_response.metrics.accumulated_usage,
                        "latencyMs": raw_final_response.metrics.accumulated_metrics.get(
                            "latencyMs", "??"
                        ),
                    },
                )
                reasoning_content = ""
                for item in raw_final_response.message.get("content", []):
                    if isinstance(item, dict) and "reasoningContent" in item:
                        r_content = item["reasoningContent"]
                        if isinstance(r_content, dict) and "reasoningText" in r_content:
                            r_text = r_content["reasoningText"]
                            if isinstance(r_text, dict) and "text" in r_text:
                                reasoning_content += r_text.get("text", "") + "\n"

                final_answer_data = {
                    "content": str(raw_final_response),
                    "sessionId": session_id,
                    "messageId": message_id,
                    "type": "text",
                }

                if reasoning_content:
                    logger.info(
                        "Model reasoning process",
                        extra={"modelReasoning": {"content": reasoning_content}},
                    )
                    final_answer_data["reasoningContent"] = reasoning_content

                if CALLBACKS and CALLBACKS.metadata.get("references"):
                    final_answer_data["references"] = json.dumps(
                        CALLBACKS.metadata["references"]
                    )

                # Include structured output as JSON when available
                # The Strands agent parses the LLM response into the Pydantic
                # model and exposes it via result.structured_output
                if STRUCTURED_OUTPUT_MODEL is not None:
                    try:
                        structured = raw_final_response.structured_output
                        if structured is not None:
                            final_answer_data[
                                "structuredOutput"
                            ] = structured.model_dump_json()
                            logger.info(
                                "Structured output included in response",
                                extra={"structuredOutput": structured.model_dump()},
                            )
                    except Exception as so_err:
                        logger.warning(
                            f"Failed to extract structured output: {so_err}",
                            extra={"error": str(so_err)},
                        )

                # Capture trajectory for evaluation features if requested
                # The trajectory contains tool calls, reasoning steps, and other
                # agent execution data needed by Strands evaluators
                if include_trajectory:
                    try:
                        finished_spans = MEMORY_EXPORTER.get_finished_spans()
                        if finished_spans:
                            mapper = StrandsInMemorySessionMapper()
                            trajectory_session = mapper.map_to_session(
                                finished_spans, session_id=session_id  # type: ignore
                            )

                            # Post-process trajectory to inject captured tool arguments
                            # The OpenTelemetry spans don't capture MCP tool arguments properly,
                            # so we enrich the trajectory with data captured in callbacks
                            if CALLBACKS and hasattr(CALLBACKS, "tool_executions"):
                                trajectory_session = enrich_trajectory(
                                    trajectory_session,
                                    CALLBACKS.tool_executions,
                                    logger,
                                )
                            final_answer_data["trajectory"] = trajectory_session
                            logger.info(
                                "Trajectory captured for evaluation",
                                extra={"spanCount": len(finished_spans)},
                            )
                        else:
                            logger.warning("No spans captured for trajectory")
                    except Exception as traj_err:
                        logger.warning(
                            f"Failed to capture trajectory: {traj_err}",
                            extra={"error": str(traj_err)},
                        )

                final_answer_payload = {
                    "action": ChatbotAction.FINAL_RESPONSE.value,
                    "userId": user_id,
                    "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
                    "type": "text",
                    "framework": "AGENT_CORE",
                    "data": final_answer_data,
                }
                logger.info(
                    "Sending the final answer",
                    extra={
                        "finalAnswerData": {
                            k: v
                            for k, v in final_answer_data.items()
                            if k != "trajectory"
                        }
                    },
                )

                yield final_answer_payload
    except Exception as err:
        logger.exception(err)
        yield {"error": str(err), "action": "error"}


if __name__ == "__main__":
    app.run()
