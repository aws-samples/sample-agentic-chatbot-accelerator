# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from shared.base_constants import RETRIEVE_FROM_KB_PREFIX
from shared.base_factory import BaseAgentFactory
from shared.mcp_client import MCPClientManager
from strands import Agent
from strands.hooks.events import (
    AfterToolCallEvent,
    BeforeToolCallEvent,
)

from .callbacks import AgentCallbacks
from .registry import InvokeSubAgentTool
from .types import (
    OrchestratorConfiguration,
    RetrievalConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger


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

    tools = mcp_tools + custom_tools

    for sub_agent in agent_configuration.agentsAsTools:
        tools.append(
            InvokeSubAgentTool(
                agent_runtime=sub_agent.runtimeId,
                agent_role=sub_agent.role,
                qualifier=sub_agent.endpoint,
            ).tool
        )

    return tools
