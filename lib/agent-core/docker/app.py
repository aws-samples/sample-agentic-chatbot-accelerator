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
from src.agentcore_memory import create_session_manager
from src.data_source import parse_configuration
from src.factory import create_agent
from src.mcp_client import MCPClientManager
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

TELEMETRY = StrandsEvalsTelemetry().setup_in_memory_exporter()
MEMORY_EXPORTER = TELEMETRY.in_memory_exporter

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


@app.entrypoint
async def invoke(payload, context: RequestContext):
    """Process user input and return a response"""
    global AGENT, CURRENT_SESSION_ID, CALLBACKS, MCP_CLIENT_MANAGER

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
                    mcp_servers=configuration.mcpServers, logger=logger
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

            AGENT, CALLBACKS = create_agent(
                configuration,
                logger,
                session_id,  # type: ignore
                user_id,
                MCP_CLIENT_MANAGER,
                session_manager,
                trace_attributes=trace_attrs,  # type: ignore
            )
            CURRENT_SESSION_ID = session_id

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
        async for event in AGENT.stream_async(
            user_message,
            invocation_state={"userId": user_id, "sessionId": session_id},
        ):
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

                # Capture trajectory for evaluation features if requested
                # The trajectory contains tool calls, reasoning steps, and other
                # agent execution data needed by Strands evaluators
                if include_trajectory:
                    try:
                        finished_spans = MEMORY_EXPORTER.get_finished_spans()
                        if finished_spans:
                            mapper = StrandsInMemorySessionMapper()
                            trajectory_session = mapper.map_to_session(
                                finished_spans, session_id=session_id
                            )

                            # Post-process trajectory to inject captured tool arguments
                            # The OpenTelemetry spans don't capture MCP tool arguments properly,
                            # so we enrich the trajectory with data captured in callbacks
                            if CALLBACKS and hasattr(CALLBACKS, "tool_executions"):
                                trajectory_session = _enrich_trajectory(
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


def _enrich_trajectory(trajectory_session, tool_executions: dict, log) -> dict:
    """Enrich trajectory with captured tool arguments and results.

    The Strands OpenTelemetry instrumentation doesn't capture MCP tool arguments
    properly. This function post-processes the trajectory to inject the tool
    data that was captured by the callbacks.

    Args:
        trajectory_session: Session object from StrandsInMemorySessionMapper
        tool_executions: Dict of tool execution data keyed by tool_call_id
        log: Logger instance

    Returns:
        Enriched trajectory (either Session object or dict depending on input)
    """
    if not tool_executions:
        return trajectory_session

    try:
        # Handle both Session object and dict representation
        if hasattr(trajectory_session, "model_dump"):
            # Convert to dict for easier manipulation
            trajectory_dict = trajectory_session.model_dump()
        elif hasattr(trajectory_session, "dict"):
            trajectory_dict = trajectory_session.dict()
        elif isinstance(trajectory_session, dict):
            trajectory_dict = trajectory_session
        else:
            log.warning(f"Unknown trajectory type: {type(trajectory_session)}")
            return trajectory_session

        enriched_count = 0

        # Iterate through traces and spans to find tool execution spans
        for trace in trajectory_dict.get("traces", []):
            for span in trace.get("spans", []):
                # Check if this is a tool execution span
                tool_call = span.get("tool_call")
                if tool_call:
                    tool_call_id = tool_call.get("tool_call_id", "")

                    # Look up the captured tool data
                    if tool_call_id in tool_executions:
                        captured_data = tool_executions[tool_call_id]

                        # Inject arguments if they were captured
                        if "arguments" in captured_data:
                            tool_call["arguments"] = captured_data["arguments"]
                            enriched_count = 1

                        # Inject result if it was captured
                        tool_result = span.get("tool_result")
                        if tool_result and "result" in captured_data:
                            tool_result["content"] = captured_data["result"]

        if enriched_count > 0:
            log.info(
                f"Enriched {enriched_count} tool calls in trajectory with captured arguments",
                extra={"enrichedCount": enriched_count},
            )

        return trajectory_dict

    except Exception as e:
        log.warning(f"Failed to enrich trajectory: {e}", extra={"error": str(e)})
        return trajectory_session


if __name__ == "__main__":
    app.run()
