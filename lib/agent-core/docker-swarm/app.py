# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from opentelemetry import baggage
from opentelemetry.context import attach
from src.data_source import parse_configuration
from src.factory import create_swarm
from src.mcp_client import MCPClientManager
from src.runner import SwarmCaller
from src.types import ChatbotAction, EStreamEvent
from src.utils import JSONFormatter
from strands import Agent
from strands.multiagent import Swarm

handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JSONFormatter())
logger = logging.getLogger("bedrock_agentcore.app")
logger.setLevel(logging.INFO)
logger.addHandler(handler)

app = BedrockAgentCoreApp()

# Global swarm variable - initialized once per session
SWARM: Swarm | None = None
AGENTS: dict[str, Agent] = {}
CURRENT_SESSION_ID: str | None = None
CALLBACKS = None
MCP_CLIENT_MANAGER: MCPClientManager | None = None

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


async def _handle_stream(
    caller: SwarmCaller,
    query: str,
    user_id: str,
    session_id: str,
    message_id: str,
    logger: logging.Logger,
) -> AsyncGenerator[dict, None]:
    """Handles streaming responses from Strands Swarm.

    This function is kept separate from SwarmCaller.invoke_stream() because SwarmCaller
    handles swarm-specific streaming (agent handoffs, multiagent events) while this function
    handles token formatting and response assembly for the client.

    Args:
        caller (SwarmCaller): Swarm caller instance for making requests
        query (str): User query text to send to the swarm
        user_id (str): Unique identifier for the requesting user
        session_id (str): Unique identifier for the current chat session
        message_id (str): Unique identifier for the current message
        logger (logging.Logger): Logger instance for debugging and monitoring

    Yields:
        dict: Stream data containing either token updates or final response payload
    """
    token_pos = 0
    run_id = str(uuid.uuid4())
    final_answer = ""

    async for strand_token in caller.invoke_stream(
        user_prompt=query, user_id=user_id, session_id=session_id
    ):
        if strand_token.flag == EStreamEvent.STREAM_COMPLETE:
            final_answer = strand_token.value
            break

        logger.debug(f"strand token: {strand_token}")

        data_to_send = {
            "action": ChatbotAction.ON_NEW_LLM_TOKEN.value,
            "userId": user_id,
            "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
            "type": "text",
            "framework": "AGENT_CORE",
            "data": {
                "sessionId": session_id,
                "token": {
                    "runId": f"f-{run_id}",
                    "sequenceNumber": token_pos,
                    "value": strand_token.value,
                },
            },
        }

        logger.debug(
            "Sent new token to the client",
            extra={
                "payload": {
                    "type": strand_token.flag.value,
                    "value": strand_token.value,
                    "position": token_pos,
                }
            },
        )
        yield data_to_send
        token_pos += 1

    final_answer_data = {
        "content": final_answer,
        "sessionId": session_id,
        "messageId": message_id,
        "type": "text",
    }
    if CALLBACKS and CALLBACKS.metadata.get("references"):
        final_answer_data["references"] = json.dumps(CALLBACKS.metadata["references"])

    final_answer_payload = {
        "action": ChatbotAction.FINAL_RESPONSE.value,
        "userId": user_id,
        "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
        "type": "text",
        "framework": "AGENT_CORE",
        "data": final_answer_data,
    }

    yield final_answer_payload


@app.entrypoint
async def invoke(payload, context: RequestContext):
    """Process user input and return a response from the swarm"""
    global SWARM, AGENTS, CURRENT_SESSION_ID, CALLBACKS, MCP_CLIENT_MANAGER

    user_message = payload.get("prompt", "Hello")
    user_id = payload.get("userId")
    message_id = payload.get("messageId")
    session_id = context.session_id

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
                    mcp_servers=list(all_mcp_servers), logger=logger
                )
                MCP_CLIENT_MANAGER.init_mcp_clients()

            # Create session manager if memory is enabled
            # NOTE: Session persistence is not yet supported for Swarm agents in Strands SDK
            # Keeping the code here for future support, but not passing to create_swarm
            if MEMORY_ID and session_id:
                logger.warning(
                    "Memory/session persistence is not yet supported for Swarm agents. "
                    "Skipping session manager creation.",
                    extra={"context": {"memoryId": MEMORY_ID}},
                )

            SWARM, CALLBACKS, AGENTS = create_swarm(
                configuration,
                logger,
                session_id=session_id,  # type: ignore
                user_id=user_id,
                mcp_client_manager=MCP_CLIENT_MANAGER,
                session_manager=None,
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
                "Failed to initialize swarm", extra={"rawErrorMessage": str(err)}
            )
            if MCP_CLIENT_MANAGER:
                MCP_CLIENT_MANAGER.cleanup_connections()
            raise err

    # Clean up metadata from previous message in the same session
    if CALLBACKS:
        CALLBACKS.reset_metadata()

    if payload.get("isHeartbeat"):
        logger.info("Exiting function because the payload is only a heartbeat")
        return

    logger.info(
        "Calling swarm with user message and context",
        extra={
            "prompt": user_message,
            "context": {"sessionId": context.session_id, "userId": user_id},
        },
    )

    swarm_caller = SwarmCaller(logger=logger, swarm=SWARM)
    try:
        async for event in _handle_stream(
            swarm_caller,
            user_message,
            user_id,
            context.session_id if context.session_id else "",
            message_id,
            logger,
        ):
            if (
                event.get("data", {}).get("action")
                == ChatbotAction.FINAL_RESPONSE.value
            ):
                logger.info(
                    "The swarm returned an answer",
                    extra={
                        "result": {
                            "finalAnswerPreview": event.get("data", {}).get(
                                "content", []
                            )[:100],
                            "thinkingProcess": event.get("data", {}).get("rationale"),
                        }
                    },
                )
                if CALLBACKS and CALLBACKS.metadata:
                    logger.info(
                        "Answer metadata", extra={"toolMetadata": CALLBACKS.metadata}
                    )

            yield event

    except Exception as err:
        logger.error("Failed swarm call", extra={"rawErrorMessage": str(err)})
        logger.exception(err)


if __name__ == "__main__":
    app.run()
