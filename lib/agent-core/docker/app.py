# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import json
import logging
import os
import sys
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
from src.utils import JSONFormatter

if TYPE_CHECKING:
    from strands.agent import AgentResult


handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JSONFormatter())
logger = logging.getLogger("bedrock_agentcore.app")
logger.setLevel(logging.INFO)
logger.addHandler(handler)

app = BedrockAgentCoreApp()

# Global agent variable - initialized once per session
AGENT = None
CURRENT_SESSION_ID: str | None = None
CALLBACKS = None
MCP_CLIENT_MANAGER: MCPClientManager | None = None

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

    # Propagate session ID for observability
    ctx = baggage.set_baggage("session.id", session_id)
    attach(ctx)

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

            AGENT, CALLBACKS = create_agent(
                configuration,
                logger,
                session_id,  # type: ignore
                user_id,
                MCP_CLIENT_MANAGER,
                session_manager,
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
                    extra={"finalAnswerData": final_answer_data},
                )

                yield final_answer_payload
    except Exception as err:
        logger.exception(err)
        yield {"error": str(err), "action": "error"}


if __name__ == "__main__":
    app.run()
