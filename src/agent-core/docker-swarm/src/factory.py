# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from shared.base_constants import RETRIEVE_FROM_KB_PREFIX
from shared.base_factory import BaseAgentFactory
from shared.mcp_client import MCPClientManager
from strands import Agent
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.multiagent import Swarm

from .callbacks import AgentCallbacks
from .types import (
    EConversationManagerType,
    SwarmAgentDefinition,
    SwarmConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger


def create_swarm(
    configuration: SwarmConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
    mcp_client_manager: MCPClientManager | None,
    session_manager: Any | None = None,
) -> tuple[Swarm, AgentCallbacks, dict[str, Agent]]:
    """
    Create and configure a Strands Swarm with multiple agents.

    Args:
        configuration: Swarm configuration including agent definitions and orchestrator settings.
        logger: Logger instance for logging swarm initialization.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        session_manager: Optional session manager for conversation state persistence.

    Returns:
        A tuple containing:
            - The configured Swarm instance
            - AgentCallbacks handler for the swarm
            - Dictionary mapping agent names to Agent instances
    """
    agents: dict[str, Agent] = {}
    entry_point_agent: Agent | None = None

    for agent_def in configuration.agents:
        agent = _create_agent_from_definition(
            agent_def=agent_def,
            logger=logger,
            mcp_client_manager=mcp_client_manager,
            conversation_manager_type=configuration.conversationManager,
            session_manager=session_manager,
        )
        agents[agent_def.name] = agent

        if agent_def.name == configuration.entryAgent:
            entry_point_agent = agent

    if entry_point_agent is None:
        raise ValueError(
            f"Entry agent '{configuration.entryAgent}' not found in created agents"
        )

    swarm = Swarm(
        nodes=list(agents.values()),
        entry_point=entry_point_agent,
        max_handoffs=configuration.orchestrator.maxHandoffs,
        max_iterations=configuration.orchestrator.maxIterations,
        execution_timeout=configuration.orchestrator.executionTimeoutSeconds,
        node_timeout=configuration.orchestrator.nodeTimeoutSeconds,
        repetitive_handoff_detection_window=configuration.orchestrator.repetitiveHandoffDetectionWindow,
        repetitive_handoff_min_unique_agents=configuration.orchestrator.repetitiveHandoffMinUniqueAgents,
    )

    logger.info(
        "Created swarm with agents",
        extra={
            "agentNames": list(agents.keys()),
            "entryAgent": configuration.entryAgent,
            "maxHandoffs": configuration.orchestrator.maxHandoffs,
            "maxIterations": configuration.orchestrator.maxIterations,
        },
    )

    callbacks = AgentCallbacks(logger, session_id, user_id)

    for agent_def in configuration.agents:
        agent = agents[agent_def.name]
        agent.hooks.add_callback(BeforeToolCallEvent, callbacks.log_tool_entries)
        agent.hooks.add_callback(AfterToolCallEvent, callbacks.log_tool_results)

        if any([t.startswith(RETRIEVE_FROM_KB_PREFIX) for t in agent_def.tools]):
            logger.info(
                f"Adding KB callback for agent '{agent_def.name}' to register sources retrieved from Knowledge Base"
            )
            agent.hooks.add_callback(
                AfterToolCallEvent, callbacks.retrieve_from_kb_callback
            )

    return swarm, callbacks, agents


def _create_agent_from_definition(
    agent_def: SwarmAgentDefinition,
    logger: Logger,
    mcp_client_manager: MCPClientManager | None,
    conversation_manager_type: EConversationManagerType,
    session_manager: Any | None = None,
) -> Agent:
    """
    Create a single Agent from a SwarmAgentDefinition.

    Args:
        agent_def: The agent definition containing configuration.
        logger: Logger instance.
        mcp_client_manager: Optional MCP client manager.
        conversation_manager_type: Type of conversation manager to use.
        session_manager: Optional session manager.

    Returns:
        Configured Agent instance.
    """
    model = BaseAgentFactory.create_model(
        model_id=agent_def.modelInferenceParameters.modelId,
        max_tokens=agent_def.modelInferenceParameters.parameters.maxTokens,
        temperature=agent_def.modelInferenceParameters.parameters.temperature,
        stop_sequences=agent_def.modelInferenceParameters.parameters.stopSequences,
        reasoning_budget=agent_def.modelInferenceParameters.reasoningBudget,
        enable_caching=True,
    )
    tools = _initialize_tools(agent_def, mcp_client_manager, logger)

    agent = Agent(
        agent_id=agent_def.name,
        name=agent_def.name,
        model=model,
        system_prompt=agent_def.instructions,
        tools=tools,
        callback_handler=None,
        conversation_manager=BaseAgentFactory.create_conversation_manager(
            conversation_manager_type.value, logger
        ),
        session_manager=session_manager,
    )

    logger.info(
        f"Created agent '{agent_def.name}' for swarm",
        extra={
            "modelId": agent_def.modelInferenceParameters.modelId,
            "toolCount": len(tools),
        },
    )

    return agent


def _initialize_tools(
    agent_def: SwarmAgentDefinition,
    mcp_client_manager: MCPClientManager | None,
    logger: Logger,
) -> list[Any]:
    """
    Initialize tools for an agent from its definition.

    Args:
        agent_def: The agent definition containing tool configurations.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        logger: Logger instance for logging tool initialization.

    Returns:
        Combined list of MCP tools and custom tools.
    """
    mcp_tools: list[Any] = []
    if mcp_client_manager and agent_def.mcpServers:
        mcp_tools = mcp_client_manager.load_mcp_tools()

    custom_tools = _initialize_custom_tools(agent_def, logger)

    logger.info(
        f"Initialized tools for agent '{agent_def.name}'",
        extra={
            "mcpToolCount": len(mcp_tools),
            "customToolCount": len(custom_tools),
        },
    )

    return BaseAgentFactory.combine_tools(mcp_tools, custom_tools, logger)


def _initialize_custom_tools(
    agent_def: SwarmAgentDefinition, logger: Logger
) -> list[Any]:
    """Initialize custom tools defined in the agent definition.

    Uses BaseAgentFactory to initialize tools consistently.

    Args:
        agent_def: Agent definition containing tool definitions and parameters.
        logger: Logger instance for logging tool initialization.

    Returns:
        List of initialized tool instances.
    """
    from .registry import AVAILABLE_TOOLS, RetrievalConfiguration

    return BaseAgentFactory.initialize_custom_tools(
        tools_list=agent_def.tools,
        tool_parameters=agent_def.toolParameters,
        available_tools=AVAILABLE_TOOLS,
        logger=logger,
        retrieval_configuration_class=RetrievalConfiguration,
        context_name=f"agent '{agent_def.name}'",
    )
