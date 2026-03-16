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
from typing import TYPE_CHECKING, Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from shared.agentcore_memory import create_session_manager
from shared.mcp_client import MCPClientManager
from shared.utils import enrich_trajectory
from src.data_source import parse_configuration
from src.factory import create_orchestrator
from src.registry import AVAILABLE_MCPS
from src.types import ChatbotAction
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

if TYPE_CHECKING:
    from strands.agent import AgentResult

logger = logging.getLogger("bedrock_agentcore.app")
logger.setLevel(logging.INFO)

app = BedrockAgentCoreApp()

# ------------------------------------------------------------------------ #
ORCHESTRATOR = None
SESSION_ID: str | None = None
CALLBACKS = None
MCP_CLIENT_MANAGER: MCPClientManager | None = None

TELEMETRY = StrandsEvalsTelemetry().setup_in_memory_exporter()
MEMORY_EXPORTER = TELEMETRY.in_memory_exporter

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")
# ------------------------------------------------------------------------ #


@app.entrypoint
async def invoke(payload: dict, context: RequestContext):
    """Process user input and return a response"""
    global ORCHESTRATOR, SESSION_ID, CALLBACKS

    user_message = payload.get("prompt", "Hello")
    user_id, session_id = _get_context(payload, context)
    message_id = payload.get("messageId")
    include_trajectory = payload.get("includeTrajectory", False)

    if include_trajectory:
        MEMORY_EXPORTER.clear()
        logger.info("Trajectory capture enabled for this request")

    # Parse optional session state from payload (stringified JSON)
    state_json = payload.get("state")
    state = json.loads(state_json) if state_json else None

    if ORCHESTRATOR is None or SESSION_ID != session_id:
        _initialize(user_id, session_id, include_trajectory, state=state)

    _reset(include_trajectory)

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
        if ORCHESTRATOR is None:
            raise AssertionError("Orchestrator must be initialized at this point.")
        async for event in ORCHESTRATOR.stream_async(
            user_message,
            invocation_state={"userId": user_id, "sessionId": session_id},
        ):
            if "data" in event:
                payload = _build_token_payload(
                    user_id, session_id, run_id, token_id, event["data"]
                )
                logger.debug("Sending a token", extra={"dataToSend": payload})
                yield payload
                token_id += 1

            elif "result" in event:
                yield _build_final_response_payload(
                    user_id,
                    session_id,
                    message_id,
                    event["result"],
                    include_trajectory,
                )
    except Exception as err:
        logger.exception(err)
        yield {"error": str(err), "action": "error"}


# --- private helpers ---


def _get_context(payload: dict, context: RequestContext) -> tuple[str, str]:
    """Fetch mandatory user_id and session_id

    Raise an exception if any of those is missing
    """
    user_id = payload.get("userId")
    session_id = context.session_id

    if user_id is None:
        raise ValueError("User identifier must be present")
    if session_id is None:
        raise ValueError("Session identifier must be present")

    return user_id, session_id


def _initialize(
    user_id: str,
    session_id: str,
    include_trajectory: bool,
    state: dict | None = None,
):
    """initialize a new agent once for each runtime container session

    Conversation state will be persisted in both local memory and remote agentcore memory.
    For resumed sessions, AgentCoreMemorySessionManager will rehydrate state from agentcore memory.
    """
    global ORCHESTRATOR, CALLBACKS, MCP_CLIENT_MANAGER, SESSION_ID

    if MCP_CLIENT_MANAGER and SESSION_ID != session_id:
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
            logger.info("Agent configured with trace attributes for trajectory capture")

        ORCHESTRATOR, CALLBACKS = create_orchestrator(
            configuration,
            logger,
            session_id,  # type: ignore
            user_id,
            MCP_CLIENT_MANAGER,
            session_manager,
            trace_attributes=trace_attrs,  # type: ignore
            state=state,
        )
        SESSION_ID = session_id

    except Exception as err:
        logger.error("Failed to initialize agent", extra={"rawErrorMessage": str(err)})
        if MCP_CLIENT_MANAGER:
            MCP_CLIENT_MANAGER.cleanup_connections()  # cleanup mcp connection if agent creation fails
        raise err


def _reset(include_trajectory: bool):
    global MEMORY_EXPORTER, CALLBACKS

    if include_trajectory:
        MEMORY_EXPORTER.clear()
        logger.info("Trajectory capture enabled for this request")

    if CALLBACKS:
        CALLBACKS.reset_metadata()


def _build_token_payload(
    user_id: str,
    session_id: str,
    run_id: str,
    token_id: int,
    token_value: str,
) -> dict:
    """Build an ``ON_NEW_LLM_TOKEN`` streaming event payload."""
    return {
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
                "value": token_value,
            },
        },
    }


def _extract_reasoning_content(agent_result: "AgentResult") -> str:
    """Extract concatenated reasoning text from an agent result message.

    Walks the nested ``reasoningContent → reasoningText → text`` structure
    and returns the combined string (empty when no reasoning is present).
    """
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


def _capture_trajectory(session_id: str) -> Any | None:
    """Capture an evaluation trajectory from in-memory OpenTelemetry spans.

    Returns the trajectory (dict or Session object) on success, or ``None``
    if spans are unavailable or an error occurs.
    """
    try:
        finished_spans = MEMORY_EXPORTER.get_finished_spans()
        if not finished_spans:
            logger.warning("No spans captured for trajectory")
            return None

        mapper = StrandsInMemorySessionMapper()
        trajectory_session = mapper.map_to_session(
            finished_spans, session_id=session_id  # type: ignore
        )

        # Post-process trajectory to inject captured tool arguments.
        # The OpenTelemetry spans don't capture MCP tool arguments properly,
        # so we enrich the trajectory with data captured in callbacks.
        if CALLBACKS and hasattr(CALLBACKS, "tool_executions"):
            trajectory_session = enrich_trajectory(
                trajectory_session,
                CALLBACKS.tool_executions,
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


def _build_final_response_payload(
    user_id: str,
    session_id: str,
    message_id: str | None,
    agent_result: "AgentResult",
    include_trajectory: bool,
) -> dict:
    """Build a ``FINAL_RESPONSE`` event payload from an agent result.

    Assembles the final answer data including optional reasoning content,
    reference metadata, and evaluation trajectory.
    """
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

    final_answer_data: dict = {
        "content": str(agent_result),
        "sessionId": session_id,
        "messageId": message_id,
        "type": "text",
    }

    # Reasoning content
    reasoning_content = _extract_reasoning_content(agent_result)
    if reasoning_content:
        logger.info(
            "Model reasoning process",
            extra={"modelReasoning": {"content": reasoning_content}},
        )
        final_answer_data["reasoningContent"] = reasoning_content

    # References from callbacks
    if CALLBACKS and CALLBACKS.metadata.get("references"):
        final_answer_data["references"] = json.dumps(CALLBACKS.metadata["references"])

    # Trajectory for evaluation
    if include_trajectory:
        trajectory = _capture_trajectory(session_id)
        if trajectory is not None:
            final_answer_data["trajectory"] = trajectory

    logger.info(
        "Sending the final answer",
        extra={
            "finalAnswerData": {
                k: v for k, v in final_answer_data.items() if k != "trajectory"
            }
        },
    )

    return {
        "action": ChatbotAction.FINAL_RESPONSE.value,
        "userId": user_id,
        "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
        "type": "text",
        "framework": "AGENT_CORE",
        "data": final_answer_data,
    }


# --- entry point ---

if __name__ == "__main__":
    app.run()
