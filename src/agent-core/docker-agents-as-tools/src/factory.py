# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

import boto3
from shared.agentcore_a2a import runtime_arn_to_a2a_url
from shared.base_constants import RETRIEVE_FROM_KB_PREFIX
from shared.base_factory import BaseAgentFactory
from shared.mcp_client import MCPClientManager
from shared.sigv4_auth import SigV4HTTPXAuth
from strands import Agent
from strands.hooks.events import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeToolCallEvent,
)
from strands_tools.a2a_client import A2AClientToolProvider

from .callbacks import AgentCallbacks
from .types import (
    AgentAsTool,
    OrchestratorConfiguration,
    RetrievalConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")


def create_orchestrator(
    configuration: OrchestratorConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
    mcp_client_manager: MCPClientManager | None,
    session_manager: Any | None = None,
    trace_attributes: dict[str, str] | None = None,
    state: dict | None = None,
) -> tuple[Agent, AgentCallbacks]:
    """
    Create and configure a Strands Agent with tools, callbacks, and conversation management.

    Args:
        configuration: Agent configuration including model parameters, tools, and instructions.
        logger: Logger instance for logging agent initialization and callbacks.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        session_manager: Optional session manager for conversation state persistence.
        trace_attributes: Optional trace attributes for observability (e.g., session.id).
            Required for trajectory capture when using evaluation features.

    Returns:
        A tuple containing the configured Agent and its AgentCallbacks handler.
    """
    model = BaseAgentFactory.create_model(
        model_id=configuration.modelInferenceParameters.modelId,
        max_tokens=configuration.modelInferenceParameters.parameters.maxTokens,
        temperature=configuration.modelInferenceParameters.parameters.temperature,
        stop_sequences=configuration.modelInferenceParameters.parameters.stopSequences,
        reasoning_budget=configuration.modelInferenceParameters.reasoningBudget,
        enable_caching=True,
    )

    agent = Agent(
        model=model,
        system_prompt=configuration.instructions,
        tools=_initialize_tools(configuration, mcp_client_manager, logger),
        callback_handler=None,
        conversation_manager=BaseAgentFactory.create_conversation_manager(
            configuration.conversationManager.value, logger
        ),
        session_manager=session_manager,
        trace_attributes=trace_attributes,
        state=state,
    )
    callbacks = AgentCallbacks(logger, session_id, user_id)

    agent.hooks.add_callback(BeforeToolCallEvent, callbacks.log_tool_entries)
    agent.hooks.add_callback(AfterToolCallEvent, callbacks.log_tool_results)
    agent.hooks.add_callback(AfterModelCallEvent, callbacks.accumulate_reasoning)

    if configuration.tools and any(
        [t.startswith(RETRIEVE_FROM_KB_PREFIX) for t in configuration.tools]
    ):
        logger.info(
            "Adding callback to register into metadata the sources retrieved from the Knowledge Base"
        )
        agent.hooks.add_callback(
            AfterToolCallEvent, callbacks.retrieve_from_kb_callback
        )

    return agent, callbacks


def _initialize_custom_tools(
    agent_configuration: OrchestratorConfiguration, logger: Logger
) -> list[Any]:
    """Initialize custom tools defined in the agent configuration.

    Uses BaseAgentFactory to initialize tools consistently.

    Args:
        agent_configuration: Agent configuration containing tool definitions and parameters.
        logger: Logger instance for logging tool initialization.

    Returns:
        List of initialized tool instances.
    """
    from .registry import AVAILABLE_TOOLS

    return BaseAgentFactory.initialize_custom_tools(
        tools_list=agent_configuration.tools if agent_configuration.tools else [],
        tool_parameters=(
            agent_configuration.toolParameters
            if agent_configuration.toolParameters
            else {}
        ),
        available_tools=AVAILABLE_TOOLS,
        logger=logger,
        retrieval_configuration_class=RetrievalConfiguration,
    )


def _initialize_tools(
    agent_configuration: OrchestratorConfiguration,
    mcp_client_manager: MCPClientManager | None,
    logger: Logger,
) -> list[Any]:
    """
    Initialize tools from the agent configuration.

    Creates a unified list that combines MCP tools from connected MCP servers
    with custom local tools defined in the agent configuration.

    Args:
        agent_configuration: The configuration for the agent containing tool definitions.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        logger: Logger instance for logging tool initialization.

    Returns:
        Combined list of MCP tools and custom tools.
    """
    mcp_tools: list[Any] = []
    if mcp_client_manager:
        mcp_tools = mcp_client_manager.load_mcp_tools()

    custom_tools = _initialize_custom_tools(agent_configuration, logger)

    sub_agent_tools = build_a2a_subagent_tools(
        agent_configuration.agentsAsTools, logger
    )

    return mcp_tools + custom_tools + sub_agent_tools


def build_a2a_subagent_tools(
    sub_agents: list[AgentAsTool],
    logger: Logger,
) -> list[Any]:
    """Build A2A client tools for all configured sub-agents.

    Each ``agentsAsTools`` entry's ``runtimeId`` is interpreted as the ARN of
    the **A2A** twin runtime (the HTTP twin is used by the React UI for
    standalone access; the orchestrator never calls that one). The URL is
    derived from the ARN at startup; no SSM lookup, no per-call signing
    setup.

    A single ``A2AClientToolProvider`` fronts all sub-agents — its
    ``known_agent_urls`` becomes one tool per URL inside the orchestrator's
    tool list. SigV4 signing is wired through ``httpx_client_args`` so every
    A2A request is signed against ``bedrock-agentcore``.
    """
    if not sub_agents:
        return []

    urls = [
        runtime_arn_to_a2a_url(sub_agent.runtimeId, AWS_REGION)
        for sub_agent in sub_agents
    ]
    logger.info(
        "Wiring A2A sub-agent tools",
        extra={"subAgentUrls": urls},
    )

    auth = SigV4HTTPXAuth(
        credentials=boto3.Session().get_credentials(),
        service="bedrock-agentcore",
        region=AWS_REGION,
    )

    provider = A2AClientToolProvider(
        known_agent_urls=urls,
        httpx_client_args={"auth": auth},
    )
    return list(provider.tools)
