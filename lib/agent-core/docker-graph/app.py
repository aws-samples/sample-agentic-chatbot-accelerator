# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import asyncio
import logging
import os
from datetime import datetime, timezone

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from opentelemetry import baggage
from opentelemetry.context import attach
from shared.stream_types import ChatbotAction
from src.data_source import parse_configuration
from src.factory import compile_graph

logger = logging.getLogger("bedrock_agentcore.app")
logger.setLevel(logging.INFO)

app = BedrockAgentCoreApp()

COMPILED_GRAPH = None
CURRENT_SESSION_ID: str | None = None
CONFIGURATION = None

MEMORY_ID = os.environ.get("memoryId")
AWS_REGION = os.environ.get("AWS_REGION")


@app.entrypoint
async def invoke(payload, context: RequestContext):
    global COMPILED_GRAPH, CURRENT_SESSION_ID, CONFIGURATION

    user_message = payload.get("prompt", "Hello")
    user_id = payload.get("userId")
    message_id = payload.get("messageId")
    session_id = context.session_id

    ctx = baggage.set_baggage("session.id", session_id)
    attach(ctx)

    if COMPILED_GRAPH is None or CURRENT_SESSION_ID != session_id:
        logger.info(
            "Initializing graph for session",
            extra={
                "context": {
                    "sessionId": session_id,
                    "userId": user_id,
                }
            },
        )

        try:
            CONFIGURATION = parse_configuration(logger)
            logger.info(
                "Graph configuration loaded",
                extra={
                    "nodeCount": len(CONFIGURATION.nodes),
                    "edgeCount": len(CONFIGURATION.edges),
                    "entryPoint": CONFIGURATION.entryPoint,
                },
            )

            if MEMORY_ID and session_id:
                logger.warning(
                    "Memory/session persistence is not yet supported for Graph agents. "
                    "Skipping session manager creation.",
                    extra={"context": {"memoryId": MEMORY_ID}},
                )

            COMPILED_GRAPH = compile_graph(
                configuration=CONFIGURATION,
                logger=logger,
                session_id=session_id,
                user_id=user_id,
            )
            CURRENT_SESSION_ID = session_id

            logger.info(
                "Graph initialized successfully",
                extra={
                    "nodeIds": [n.id for n in CONFIGURATION.nodes],
                    "entryPoint": CONFIGURATION.entryPoint,
                },
            )

        except Exception as err:
            logger.error(
                "Failed to initialize graph", extra={"rawErrorMessage": str(err)}
            )
            raise err

    if payload.get("isHeartbeat"):
        logger.info("Exiting function because the payload is only a heartbeat")
        return

    logger.info(
        "Calling graph with user message and context",
        extra={
            "prompt": user_message,
            "context": {"sessionId": context.session_id, "userId": user_id},
        },
    )

    try:
        input_state = {"messages": [user_message]}

        invoke_config = {
            "recursion_limit": CONFIGURATION.orchestrator.maxIterations,
        }

        timeout_seconds = CONFIGURATION.orchestrator.executionTimeoutSeconds

        result = await asyncio.wait_for(
            COMPILED_GRAPH.ainvoke(input_state, config=invoke_config),
            timeout=timeout_seconds,
        )

        logger.info(
            "Graph completed",
            extra={
                "resultKeys": list(result.keys()) if isinstance(result, dict) else None,
            },
        )

        final_content = ""
        if isinstance(result, dict):
            messages = result.get("messages", "")
            if isinstance(messages, str):
                # LangGraph state replacement: messages is the content string directly
                final_content = messages
            elif isinstance(messages, list) and messages:
                last_message = messages[-1]
                final_content = (
                    str(last_message)
                    if not isinstance(last_message, str)
                    else last_message
                )
            else:
                final_content = str(result)
        else:
            final_content = str(result)

        final_answer_data = {
            "content": final_content,
            "sessionId": session_id,
            "messageId": message_id,
            "type": "text",
        }

        final_answer_payload = {
            "action": ChatbotAction.FINAL_RESPONSE.value,
            "userId": user_id,
            "timestamp": int(round(datetime.now(timezone.utc).timestamp())),
            "type": "text",
            "framework": "AGENT_CORE",
            "data": final_answer_data,
        }

        yield final_answer_payload

    except asyncio.TimeoutError:
        timeout_msg = (
            f"Graph execution timed out after "
            f"{CONFIGURATION.orchestrator.executionTimeoutSeconds}s"
        )
        logger.error(timeout_msg)
        yield {"error": timeout_msg, "action": "error"}

    except Exception as err:
        logger.error("Failed graph call", extra={"rawErrorMessage": str(err)})
        logger.exception(err)
        yield {"error": str(err), "action": "error"}


if __name__ == "__main__":
    app.run()
