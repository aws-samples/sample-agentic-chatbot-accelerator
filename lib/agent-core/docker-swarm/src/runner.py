# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from typing import TYPE_CHECKING, AsyncGenerator, Union

from strands.multiagent import Swarm
from strands.types.exceptions import EventLoopException, ModelThrottledException

from .types import EStreamEvent, StrandToken

if TYPE_CHECKING:
    from logging import Logger as StdLogger

    from aws_lambda_powertools import Logger


class SwarmCaller:
    """A class for making calls to a Strands Swarm.

    This class handles invocation of a Strands Swarm that orchestrates multiple agents
    using Amazon Bedrock models for inference. It manages streaming responses from
    the swarm as agents collaborate and hand off to each other.

    Args:
        logger (Union[StdLogger, Logger]): Logger instance for logging events and debugging
        swarm (Swarm): The configured Strands Swarm instance

    Attributes:
        _swarm (Swarm): The configured Strands swarm instance used for inference
    """

    def __init__(
        self,
        logger: Union[StdLogger, Logger],
        swarm: Swarm,
    ):
        self._logger = logger
        self._swarm = swarm

    @property
    def swarm(self) -> Swarm:
        return self._swarm

    def _extract_final_response(self, swarm_result) -> str:
        """Extract the final text response from a SwarmResult.

        The SwarmResult contains results from all agents that executed.
        We need to get the last agent's final message text.

        Args:
            swarm_result: The SwarmResult object from the swarm execution.

        Returns:
            The extracted text content from the last agent's response.
        """
        try:
            if hasattr(swarm_result, "node_history") and swarm_result.node_history:
                last_node = swarm_result.node_history[-1]
                last_node_id = (
                    last_node.node_id
                    if hasattr(last_node, "node_id")
                    else str(last_node)
                )

                if hasattr(swarm_result, "results") and swarm_result.results:
                    node_result = swarm_result.results.get(last_node_id)
                    if node_result:
                        return self._extract_text_from_node_result(node_result)

            # Fallback: try to get any result from the results dict
            if hasattr(swarm_result, "results") and swarm_result.results:
                last_result = list(swarm_result.results.values())[-1]
                return self._extract_text_from_node_result(last_result)

        except Exception as e:
            self._logger.warning(
                f"Failed to extract final response from SwarmResult: {e}"
            )

        return str(swarm_result)

    def _extract_text_from_node_result(self, node_result) -> str:
        """Extract text content from a NodeResult.

        Args:
            node_result: The NodeResult object containing the agent's response.

        Returns:
            The extracted text content.
        """
        try:
            if not hasattr(node_result, "result") or not node_result.result:
                return str(node_result)

            agent_result = node_result.result

            if not hasattr(agent_result, "message") or not agent_result.message:
                return str(agent_result)

            message = agent_result.message

            # Handle message as dict (common case)
            if isinstance(message, dict):
                content = message.get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and "text" in block:
                            return block["text"]
                elif isinstance(content, str):
                    return content

            # Handle message as object with content attribute
            if hasattr(message, "content"):
                content = message.content
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and "text" in block:
                            return block["text"]
                        if hasattr(block, "text"):
                            return block.text
                elif isinstance(content, str):
                    return content

        except Exception as e:
            self._logger.warning(f"Failed to extract text from NodeResult: {e}")

        return str(node_result)

    async def invoke_stream(
        self,
        user_prompt: str,
        user_id: str,
        session_id: str,
    ) -> AsyncGenerator[StrandToken, None]:
        """Invokes the Strands swarm with a prompt and streams the response.

        The swarm will orchestrate multiple agents, handling handoffs between them
        as needed to complete the task.

        Args:
            user_prompt (str): Message from the user that is sent to the swarm.
            user_id (str): User identifier, passed as context to the agents
            session_id (str): Session, passed as context to the agents

        Yields:
            StrandToken: A token containing the agent's response text and a flag indicating
                the type of response (final response token or stream complete).

        Raises:
            EventLoopException: If the swarm encounters an event loop error.
            ModelThrottledException: If the model is throttled.
        """
        self._logger.info(f"Sending to swarm: {user_prompt}")

        try:
            async for event in self._swarm.stream_async(
                user_prompt,
                invocation_state={"userId": user_id, "sessionId": session_id},
            ):
                event_type = event.get("type", "")

                # Handle streaming events from agents within the swarm
                if event_type == "multiagent_node_stream":
                    agent_event = event.get("event", {})
                    if "data" in agent_event:
                        yield StrandToken(
                            value=agent_event["data"],
                            flag=EStreamEvent.FINAL_RESPONSE_TOKEN,
                        )

                # Log agent handoffs for observability
                elif event_type == "multiagent_handoff":
                    self._logger.info(
                        "Agent handoff occurred",
                        extra={
                            "fromAgents": event.get("from_node_ids"),
                            "toAgents": event.get("to_node_ids"),
                            "handoffMessage": event.get("message"),
                        },
                    )

                elif event_type == "multiagent_result":
                    raw_final_response = event.get("result")
                    if raw_final_response:
                        result_content = self._extract_final_response(
                            raw_final_response
                        )
                        yield StrandToken(
                            value=result_content.strip(),
                            flag=EStreamEvent.STREAM_COMPLETE,
                        )
        except (EventLoopException, ModelThrottledException) as err:
            self._logger.error(str(err))
            self._logger.exception(err)
            raise
