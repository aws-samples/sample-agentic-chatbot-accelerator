# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from strands import Agent
from strands.agent.conversation_manager import (
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.hooks.events import (
    AfterToolCallEvent,
    BeforeToolCallEvent,
)
from strands.models import BedrockModel

from .callbacks import AgentCallbacks
from .constants import RETRIEVE_FROM_KB_PREFIX
from .mcp_client import MCPClientManager
from .types import (
    AgentConfiguration,
    EConversationManagerType,
    ModelConfiguration,
    RetrievalConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger

    from strands.agent.conversation_manager import ConversationManager

MODELS_THAT_SUPPORT_CACHING = (
    # Nova
    "amazon.nova-micro-v1:0",
    "amazon.nova-lite-v1:0",
    "amazon.nova-pro-v1:0",
    # Nova 2
    "amazon.nova-2-lite-v1:0",
    # Anthropic
    "anthropic.claude-sonnet-4-20250514-v1:0",
    "anthropic.claude-3-7-sonnet-20250219-v1:0",
    "anthropic.claude-3-5-haiku-20241022-v1:0",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
)


def create_agent(
    configuration: AgentConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
    mcp_client_manager: MCPClientManager | None,
    session_manager: Any | None = None,
    trace_attributes: dict[str, str] | None = None,
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
    model = _create_model(configuration.modelInferenceParameters)

    agent = Agent(
        model=model,
        system_prompt=configuration.instructions,
        tools=_initialize_tools(configuration, mcp_client_manager, logger),
        callback_handler=None,
        conversation_manager=_create_conversation_manager(
            configuration.conversationManager, logger
        ),
        session_manager=session_manager,
        trace_attributes=trace_attributes,
    )
    callbacks = AgentCallbacks(logger, session_id, user_id)

    agent.hooks.add_callback(BeforeToolCallEvent, callbacks.log_tool_entries)
    agent.hooks.add_callback(AfterToolCallEvent, callbacks.log_tool_results)

    if any([t.startswith(RETRIEVE_FROM_KB_PREFIX) for t in configuration.tools]):
        logger.info(
            "Adding callback to register into metadata the sources retrieved from the Knowledge Base"
        )
        agent.hooks.add_callback(
            AfterToolCallEvent, callbacks.retrieve_from_kb_callback
        )

    return agent, callbacks


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
        "cache_prompt": (
            "default"
            if any(
                configuration.modelId.endswith(m) for m in MODELS_THAT_SUPPORT_CACHING
            )
            else None
        ),
        "max_tokens": configuration.parameters.maxTokens,
        "temperature": configuration.parameters.temperature,
        "stop_sequences": configuration.parameters.stopSequences,
    }

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
        Defaults to SlidingWindowConversationManager if an unexpected type is provided.
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


def _initialize_custom_tools(
    agent_configuration: AgentConfiguration, logger: Logger
) -> list[Any]:
    """
    Initialize custom tools defined in the agent configuration.

    Handles two types of tools:
    - Knowledge Base retrieval tools (RETRIEVE_FROM_KB_PREFIX)
    - Standard tools and sub-agent invocation tools (INVOKE_SUBAGENT_PREFIX)

    Args:
        agent_configuration: Agent configuration containing tool definitions and parameters.
        logger: Logger instance for logging tool initialization.

    Returns:
        List of initialized tool instances.

    Raises:
        KeyError: If a tool is missing from toolParameters.
    """
    # Import here to avoid circular dependency between factory and registry modules
    from .constants import INVOKE_SUBAGENT_PREFIX, RETRIEVE_FROM_KB_PREFIX
    from .registry import AVAILABLE_TOOLS

    agent_tools: list[Any] = []
    for tool_name in agent_configuration.tools:
        if tool_name not in agent_configuration.toolParameters:
            logger.warning(f"Tool '{tool_name}' not found in toolParameters, skipping")
            continue

        # Copy params to avoid mutating the original configuration
        params = agent_configuration.toolParameters[tool_name].copy()

        if tool_name.startswith(RETRIEVE_FROM_KB_PREFIX):
            kb_id = params["kb_id"]
            retrieval_cfg = RetrievalConfiguration.model_validate(
                params["retrieval_cfg"]
            )
            tool_factory = AVAILABLE_TOOLS[RETRIEVE_FROM_KB_PREFIX]["factory"]
            tool = tool_factory(kb_id=kb_id, cfg=retrieval_cfg)

            agent_tools.append(tool)
            logger.info(f"Connected knowledge base {kb_id} to the agent")

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
                f"Initializing tool '{tool_name}'",
                extra={"parameters": params},
            )
            if record.get("invokes_sub_agent", False):
                logger.info("The tool invokes a sub-agent")

            # Remove internal flag before passing to factory
            params.pop("invokesSubAgent", None)
            agent_tools.append(tool_factory(**params))
            logger.info(f"Added tool '{tool_name}' to the agent")
        else:
            logger.warning(f"Unknown tool '{tool_name}', skipping")

    return agent_tools


def _initialize_tools(
    agent_configuration: AgentConfiguration,
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

    logger.info(
        f"Found {len(mcp_tools)} MCP tools and {len(custom_tools)} custom tools."
    )

    return mcp_tools + custom_tools
