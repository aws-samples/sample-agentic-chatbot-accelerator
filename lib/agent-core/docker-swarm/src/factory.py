# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from strands import Agent
from strands.agent.conversation_manager import (
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.models import BedrockModel
from strands.multiagent import Swarm

from .callbacks import AgentCallbacks
from .constants import RETRIEVE_FROM_KB_PREFIX
from .mcp_client import MCPClientManager
from .types import (
    EConversationManagerType,
    ModelConfiguration,
    SwarmAgentDefinition,
    SwarmConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger

    from strands.agent.conversation_manager import ConversationManager

MODELS_THAT_SUPPORT_CACHING = (
    "us.amazon.nova-micro-v1:0",
    "us.amazon.nova-lite-v1:0",
    "us.amazon.nova-pro-v1:0",
    "us.anthropic.claude-sonnet-4-20250514-v1:0",
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "us.anthropic.claude-3-5-haiku-20241022-v1:0",
)
MODELS_WITHOUT_TOP_P = {"anthropic.claude-haiku-4-5-20251001-v1:0"}


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
    model = _create_model(agent_def.modelInferenceParameters)
    tools = _initialize_tools(agent_def, mcp_client_manager, logger)

    agent = Agent(
        agent_id=agent_def.name,
        name=agent_def.name,
        model=model,
        system_prompt=agent_def.instructions,
        tools=tools,
        callback_handler=None,
        conversation_manager=_create_conversation_manager(
            conversation_manager_type, logger
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


def _create_model(configuration: ModelConfiguration) -> BedrockModel:
    """
    Create a BedrockModel instance from the model configuration.

    Args:
        configuration: Model configuration including model ID and inference parameters.

    Returns:
        A configured BedrockModel instance.
    """
    model_args: dict[str, Any] = {
        "model_id": configuration.modelId,
        "max_tokens": configuration.parameters.maxTokens,
        "temperature": configuration.parameters.temperature,
        "top_p": configuration.parameters.topP,
        "stop_sequences": configuration.parameters.stopSequences,
    }
    if any(configuration.modelId.endswith(model) for model in MODELS_WITHOUT_TOP_P):
        del model_args["top_p"]

    return BedrockModel(**model_args)


def _create_conversation_manager(
    manager: EConversationManagerType, logger: Logger
) -> ConversationManager:
    """
    Creates and returns a conversation manager instance based on the specified type.

    Args:
        manager (EConversationManagerType): The type of conversation manager to create
        logger: Logger instance for logging warnings

    Returns:
        ConversationManager: An instance of the specified conversation manager type.
    """
    if manager == EConversationManagerType.SLIDING_WINDOW:
        out = SlidingWindowConversationManager()
    elif manager == EConversationManagerType.SUMMARIZING:
        out = SummarizingConversationManager()
    elif manager == EConversationManagerType.NULL:
        out = NullConversationManager()
    else:
        logger.warning(
            f"Unexpected conversation manager {manager}. Defaulting to SLIDING_WINDOW"
        )
        out = SlidingWindowConversationManager()

    return out


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

    return mcp_tools + custom_tools


def _initialize_custom_tools(
    agent_def: SwarmAgentDefinition, logger: Logger
) -> list[Any]:
    """
    Initialize custom tools defined in the agent definition.

    Args:
        agent_def: Agent definition containing tool definitions and parameters.
        logger: Logger instance for logging tool initialization.

    Returns:
        List of initialized tool instances.
    """
    from .constants import INVOKE_SUBAGENT_PREFIX, RETRIEVE_FROM_KB_PREFIX
    from .registry import AVAILABLE_TOOLS, RetrievalConfiguration

    agent_tools: list[Any] = []
    for tool_name in agent_def.tools:
        if tool_name not in agent_def.toolParameters:
            logger.warning(
                f"Tool '{tool_name}' not found in toolParameters for agent '{agent_def.name}', skipping"
            )
            continue

        params = agent_def.toolParameters[tool_name].copy()

        if tool_name.startswith(RETRIEVE_FROM_KB_PREFIX):
            kb_id = params["kb_id"]
            retrieval_cfg = RetrievalConfiguration.model_validate(
                params["retrieval_cfg"]
            )
            tool_factory = AVAILABLE_TOOLS[RETRIEVE_FROM_KB_PREFIX]["factory"]
            tool = tool_factory(kb_id=kb_id, cfg=retrieval_cfg)

            agent_tools.append(tool)
            logger.info(f"Connected knowledge base {kb_id} to agent '{agent_def.name}'")

        elif tool_name in AVAILABLE_TOOLS or tool_name.startswith(
            INVOKE_SUBAGENT_PREFIX
        ):
            record = (
                AVAILABLE_TOOLS[tool_name]
                if tool_name in AVAILABLE_TOOLS
                else AVAILABLE_TOOLS[INVOKE_SUBAGENT_PREFIX]
            )
            tool_factory = record["factory"]
            logger.info(
                f"Initializing tool '{tool_name}' for agent '{agent_def.name}'",
                extra={"parameters": params},
            )

            params.pop("invokesSubAgent", None)
            agent_tools.append(tool_factory(**params))
            logger.info(f"Added tool '{tool_name}' to agent '{agent_def.name}'")
        else:
            logger.warning(
                f"Unknown tool '{tool_name}' for agent '{agent_def.name}', skipping"
            )

    return agent_tools
