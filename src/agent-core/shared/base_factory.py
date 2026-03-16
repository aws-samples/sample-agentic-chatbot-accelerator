# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared base classes for agent and swarm factory implementations.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

import boto3
from strands.agent.conversation_manager import (
    ConversationManager,
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.models import BedrockModel

from .base_constants import RETRIEVE_FROM_KB_PREFIX
from .stream_types import ReasoningEffort

_cross_account_logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from logging import Logger

# Models that require an integer reasoning budget (minimum 1024 tokens)
_INT_BUDGET_MODELS_ANTHROPIC = {
    "claude-opus-4-5",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-7-sonnet",
}

# Models that require a ReasoningEffort enum value
_EFFORT_BUDGET_MODELS_ANTHROPIC = {
    "claude-sonnet-4-6",
    "claude-opus-4-6",
}

_EFFORT_BUDGET_MODELS_NOVA = {
    "nova-2-lite",
}


class BaseAgentFactory:
    """Base class for agent and swarm factory implementations.

    This class provides common functionality for creating agents including:
    - Model initialization with prompt caching support
    - Conversation manager creation
    - Tool initialization patterns

    Subclasses should use these methods to build agents consistently.
    """

    # Models that support prompt caching
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
        "anthropic.claude-opus-4-6-v1",
        "anthropic.claude-sonnet-4-6",
    )

    @staticmethod
    def create_model(
        model_id: str,
        max_tokens: int,
        temperature: float,
        stop_sequences: list[str] | None = None,
        enable_caching: bool = True,
        reasoning_budget: ReasoningEffort | int | None = None,
    ) -> BedrockModel:
        """Create a BedrockModel instance with optional prompt caching.

        Args:
            model_id (str): The Bedrock model ID
            max_tokens (int): Maximum tokens for generation
            temperature (float): Temperature for sampling
            stop_sequences (list[str] | None): Stop sequences for generation. Defaults to None.
                Only included in model config if provided and non-empty.
            enable_caching (bool): Whether to enable prompt caching if supported. Defaults to True.

        Returns:
            BedrockModel: Configured BedrockModel instance
        """
        model_args: dict[str, Any] = {
            "model_id": model_id,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        # Only include stop_sequences if explicitly provided and non-empty
        # Some models (e.g., openai.gpt-oss-20b-1:0) don't support this field
        if stop_sequences:
            model_args["stop_sequences"] = stop_sequences

        # Add prompt caching if enabled and model supports it
        if enable_caching and any(
            model_id.endswith(m) for m in BaseAgentFactory.MODELS_THAT_SUPPORT_CACHING
        ):
            model_args["cache_prompt"] = "default"

        if reasoning_budget is not None:
            reasoning_cfg: dict = {"type": "enabled"}
            reasoning_val = (
                reasoning_budget.value
                if isinstance(reasoning_budget, ReasoningEffort)
                else reasoning_budget
            )

            set_additional_args = True
            temp_add_args = {}
            if any(m in model_id for m in _EFFORT_BUDGET_MODELS_ANTHROPIC):
                reasoning_key = "thinking"
                reasoning_cfg["type"] = "adaptive"
                temp_add_args["output_config"] = {"effort": reasoning_val}
                del model_args["temperature"]
                # If thinking is enabled with Anthropic models, temperature cannot be set
            elif any(m in model_id for m in _INT_BUDGET_MODELS_ANTHROPIC):
                reasoning_key = "thinking"
                reasoning_cfg["budget_tokens"] = reasoning_val
                # If thinking is enabled with Anthropic models, temperature cannot be set
                del model_args["temperature"]
            elif any(m in model_id for m in _EFFORT_BUDGET_MODELS_NOVA):
                reasoning_key = "reasoningConfig"
                reasoning_cfg["maxReasoningEffort"] = reasoning_val
            else:
                set_additional_args = False

            if set_additional_args:
                model_args["additional_request_fields"] = temp_add_args | {
                    reasoning_key: reasoning_cfg
                }
        # Use cross-account session if a Bedrock access role ARN is configured
        bedrock_access_role_arn = os.environ.get("bedrockAccessRoleArn")
        if bedrock_access_role_arn:
            boto_session = BaseAgentFactory._get_cross_account_boto_session(
                bedrock_access_role_arn
            )
            model_args["boto_session"] = boto_session

        return BedrockModel(**model_args)

    @staticmethod
    def _get_cross_account_boto_session(role_arn: str) -> boto3.Session:
        """Assume a cross-account IAM role and return a boto3 Session with temporary credentials.

        This enables invoking Bedrock models in a different AWS account that hosts
        the model access. The role is assumed via STS and the resulting temporary
        credentials are used to create a new boto3 Session.

        Args:
            role_arn (str): The ARN of the cross-account role to assume.

        Returns:
            boto3.Session: A boto3 session configured with assumed-role credentials.
        """
        _cross_account_logger.info(
            f"Assuming cross-account role for Bedrock access: {role_arn}"
        )
        sts_client = boto3.client("sts")
        response = sts_client.assume_role(
            RoleArn=role_arn,
            RoleSessionName="AgentCoreCrossAccountBedrock",
            DurationSeconds=3600,
        )
        credentials = response["Credentials"]
        _cross_account_logger.info(
            f"Successfully assumed cross-account role. Session expires at: {credentials['Expiration']}"
        )
        return boto3.Session(
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        )

    @staticmethod
    def create_conversation_manager(
        manager_type: str, logger: Logger
    ) -> ConversationManager:
        """Create a conversation manager based on the specified type.

        Args:
            manager_type (str): The type of conversation manager
                (SLIDING_WINDOW, SUMMARIZING, or NULL)
            logger (Logger): Logger instance for logging warnings

        Returns:
            ConversationManager: An instance of the specified conversation manager type.
                Defaults to SlidingWindowConversationManager if type is unexpected.
        """
        if manager_type == "SLIDING_WINDOW":
            return SlidingWindowConversationManager()
        elif manager_type == "SUMMARIZING":
            return SummarizingConversationManager()
        elif manager_type == "NULL":
            return NullConversationManager()
        else:
            logger.warning(
                f"Unexpected conversation manager {manager_type}. Defaulting to SLIDING_WINDOW"
            )
            return SlidingWindowConversationManager()

    @staticmethod
    def initialize_kb_tool(
        params: dict,
        available_tools: dict,
        logger: Logger,
        context_name: str | None = None,
    ) -> Any:
        """Initialize a Knowledge Base retrieval tool.

        Args:
            params (dict): Tool parameters containing kb_id and retrieval_cfg
            available_tools (dict): Registry of available tools
            logger (Logger): Logger instance
            context_name (str | None): Optional context name (e.g., agent name) for logging

        Returns:
            Any: Initialized KB tool instance
        """
        # Import RetrievalConfiguration from the caller's registry
        # This is handled by the subclass passing the right type
        kb_id = params["kb_id"]
        retrieval_cfg = params["retrieval_cfg"]
        tool_factory = available_tools[RETRIEVE_FROM_KB_PREFIX]["factory"]
        tool = tool_factory(kb_id=kb_id, cfg=retrieval_cfg)

        context_msg = f" to {context_name}" if context_name else ""
        logger.info(f"Connected knowledge base {kb_id}{context_msg}")

        return tool

    @staticmethod
    def initialize_standard_tool(
        tool_name: str,
        params: dict,
        available_tools: dict,
        logger: Logger,
        context_name: str | None = None,
    ) -> Any:
        """Initialize a standard tool or sub-agent invocation tool.

        Args:
            tool_name (str): Name of the tool
            params (dict): Tool parameters
            available_tools (dict): Registry of available tools
            logger (Logger): Logger instance
            context_name (str | None): Optional context name (e.g., agent name) for logging

        Returns:
            Any: Initialized tool instance
        """
        record = available_tools[tool_name]

        tool_factory = record["factory"]

        context_msg = f" for {context_name}" if context_name else ""
        logger.info(
            f"Initializing tool '{tool_name}'{context_msg}",
            extra={"parameters": params},
        )

        if record.get("invokes_sub_agent", False):
            logger.info("The tool invokes a sub-agent")

        # Remove internal flag before passing to factory
        params.pop("invokesSubAgent", None)
        tool = tool_factory(**params)

        logger.info(f"Added tool '{tool_name}'{context_msg}")

        return tool

    @staticmethod
    def initialize_custom_tools(
        tools_list: list[str],
        tool_parameters: dict,
        available_tools: dict,
        logger: Logger,
        retrieval_configuration_class: type,
        context_name: str | None = None,
    ) -> list[Any]:
        """Initialize custom tools from configuration.

        Handles both Knowledge Base retrieval tools and standard tools.

        Args:
            tools_list (list[str]): List of tool names to initialize
            tool_parameters (dict): Dictionary mapping tool names to their parameters
            available_tools (dict): Registry of available tools with factories
            logger (Logger): Logger instance for logging
            retrieval_configuration_class (type): The RetrievalConfiguration class to use
            context_name (str | None): Optional context name (e.g., agent name) for logging

        Returns:
            list[Any]: List of initialized tool instances
        """
        initialized_tools: list[Any] = []

        for tool_name in tools_list:
            if tool_name not in tool_parameters:
                warning_msg = f"Tool '{tool_name}' not found in toolParameters"
                if context_name:
                    warning_msg += f" for {context_name}"
                logger.warning(warning_msg + ", skipping")
                continue

            # Copy params to avoid mutating the original configuration
            params = tool_parameters[tool_name].copy()

            if tool_name.startswith(RETRIEVE_FROM_KB_PREFIX):
                # Validate retrieval configuration
                params["retrieval_cfg"] = retrieval_configuration_class.model_validate(
                    params["retrieval_cfg"]
                )
                tool = BaseAgentFactory.initialize_kb_tool(
                    params, available_tools, logger, context_name
                )
                initialized_tools.append(tool)
            else:
                warning_msg = f"Unknown tool '{tool_name}'"
                if context_name:
                    warning_msg += f" for {context_name}"
                logger.warning(warning_msg + ", skipping")

        return initialized_tools

    @staticmethod
    def combine_tools(
        mcp_tools: list[Any], custom_tools: list[Any], logger: Logger
    ) -> list[Any]:
        """Combine MCP tools and custom tools into a single list.

        Args:
            mcp_tools (list[Any]): List of MCP tools
            custom_tools (list[Any]): List of custom tools
            logger (Logger): Logger instance for logging

        Returns:
            list[Any]: Combined list of all tools
        """
        logger.info(
            f"Found {len(mcp_tools)} MCP tools and {len(custom_tools)} custom tools."
        )
        return mcp_tools + custom_tools
