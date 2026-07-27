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
from strands.models import BedrockModel, Model

from . import mantle_support
from .base_constants import RETRIEVE_FROM_KB_PREFIX
from .stream_types import ReasoningEffort

_cross_account_logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from logging import Logger

    from strands.models import AnthropicModel, OpenAIModel

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
    ) -> Model:
        """Create the Strands model for ``model_id``, routing by Mantle membership.

        Dispatches by provider on an exact-id membership test against the Bedrock
        Mantle catalog:

        - not on Mantle → ``BedrockModel`` (the Converse path, unchanged).
        - on Mantle, ``anthropic.*`` → ``AnthropicModel`` (Mantle Messages API).
        - on Mantle, anything else → ``OpenAIModel`` (Mantle Chat Completions).

        The Converse-path arg assembly below (``model_args``, ``cache_prompt``,
        reasoning ``additional_request_fields``, ``stop_sequences``, cross-account
        ``boto_session``) is used only by the ``BedrockModel`` branch; for any
        ``model_id`` absent from the Mantle catalog, behavior is identical to
        before this routing was introduced. The membership check reads a
        process-cached set, so it adds no per-call network round-trip.

        Args:
            model_id (str): The configured model id (Converse-form or Mantle id).
            max_tokens (int): Maximum tokens for generation.
            temperature (float): Temperature for sampling.
            stop_sequences (list[str] | None): Converse-only stop sequences,
                passed to ``BedrockModel`` when provided and non-empty. Defaults
                to None.
            enable_caching (bool): Converse-only prompt caching, applied when the
                model supports it. Defaults to True.
            reasoning_budget (ReasoningEffort | int | None): Reasoning budget,
                mapped per branch. Defaults to None.

        Returns:
            Model: An ``OpenAIModel`` (Mantle non-Anthropic), ``AnthropicModel``
                (Mantle ``anthropic.*``), or ``BedrockModel`` (non-Mantle).
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

        # Route by provider on an exact-id membership test. Non-Mantle ids take
        # the Converse path with the model_args assembled above; Mantle ids are
        # built from the caller inputs directly (Converse-only args do not apply).
        if not mantle_support.is_on_mantle(model_id):
            return BedrockModel(**model_args)
        if model_id.startswith("anthropic."):
            return BaseAgentFactory._build_anthropic_mantle(
                model_id, max_tokens, temperature, reasoning_budget
            )
        return BaseAgentFactory._build_openai_mantle(
            model_id, max_tokens, temperature, reasoning_budget
        )

    @staticmethod
    def _build_openai_mantle(
        model_id: str,
        max_tokens: int,
        temperature: float,
        reasoning_budget: ReasoningEffort | int | None = None,
    ) -> OpenAIModel:
        """Build an OpenAIModel routed through Bedrock Mantle (Chat Completions).

        Inference params go inside a ``params`` dict (OpenAIConfig shape), NOT as
        top-level kwargs the way BedrockModel takes them. Endpoint wiring is
        turnkey via ``bedrock_mantle_config``: strands builds the ``…/v1`` base
        URL and mints a fresh bearer token per request internally (see
        ``strands.models._openai_bedrock``). MUST NOT pass any Converse-only arg
        (``cache_prompt``, ``additional_request_fields``, ``stop_sequences``,
        ``boto_session``).

        Args:
            model_id (str): Mantle model id (e.g. ``"openai.gpt-oss-20b"``).
            max_tokens (int): Maximum tokens for generation.
            temperature (float): Sampling temperature.
            reasoning_budget (ReasoningEffort | int | None): When set, mapped to
                ``params["reasoning_effort"]`` as an OpenAI-style enum string
                (``low``/``medium``/``high``). Defaults to None.

        Returns:
            OpenAIModel: Model configured for the Mantle Chat Completions surface.
        """
        # Import lazily: strands.models.openai does `import openai` at module
        # top, and the openai SDK only ships in the model-building containers
        # (see T4). A top-level import here would break `import base_factory`
        # everywhere the SDK is absent (local tests, non-Mantle patterns).
        from strands.models import OpenAIModel

        params: dict[str, Any] = {
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if reasoning_budget is not None:
            params["reasoning_effort"] = (
                reasoning_budget.value
                if isinstance(reasoning_budget, ReasoningEffort)
                else reasoning_budget
            )

        return OpenAIModel(
            model_id=model_id,
            params=params,
            bedrock_mantle_config={"region": os.environ["AWS_REGION"]},
        )

    @staticmethod
    def _build_anthropic_mantle(
        model_id: str,
        max_tokens: int,
        temperature: float,
        reasoning_budget: ReasoningEffort | int | None = None,
    ) -> AnthropicModel:
        """Build an AnthropicModel routed through Bedrock Mantle (Messages API).

        AnthropicModel has no Mantle helper, so the endpoint is injected via
        ``client_args`` (``base_url`` + a minted ``api_key``) using T1's shared
        helpers. Inference params go inside a ``params`` dict, which strands
        passes verbatim into the Messages request body.

        Only the newest Claude is Mantle-eligible (see ADR-0003), and every
        Claude from Opus 4.7 onward rejects a non-default ``temperature`` /
        ``top_p`` / ``top_k`` with a 400. So ``temperature`` is deliberately
        NOT forwarded on this branch, matching Anthropic's guidance to omit
        sampling params entirely. Reasoning/thinking is also omitted: the
        Messages ``thinking`` shape differs from OpenAI ``reasoning_effort`` and
        is left for a follow-up rather than guessed (T2 decision).

        MUST NOT pass any Converse-only arg (``cache_prompt``,
        ``additional_request_fields``, ``stop_sequences``, ``boto_session``).

        Args:
            model_id (str): Mantle model id (e.g. ``"anthropic.claude-sonnet-5"``).
            max_tokens (int): Maximum tokens for generation (required).
            temperature (float): Sampling temperature. Accepted for a uniform
                builder signature but intentionally not sent (see above).
            reasoning_budget (ReasoningEffort | int | None): Not yet mapped on
                the Anthropic branch; see follow-up note above. Defaults to None.

        Returns:
            AnthropicModel: Model configured for the Mantle Messages surface.
        """
        # Import lazily: strands.models.anthropic does `import anthropic` at
        # module top; the anthropic SDK only ships in the model-building
        # containers (see T4). Mirrors the OpenAI branch above.
        from strands.models import AnthropicModel

        region = os.environ["AWS_REGION"]

        # NOTE: static api_key minted at construction. The model is built per
        # session and tokens are short-lived (bounded lifetime), so a long-lived
        # session could outlive the token. OpenAIModel re-mints per request via
        # bedrock_mantle_config; AnthropicModel has no equivalent. Follow-up:
        # per-session re-mint / custom credential provider if this bites.
        return AnthropicModel(
            client_args={
                "base_url": mantle_support.anthropic_base_url(region),
                "api_key": mantle_support.mint_token(region),
            },
            model_id=model_id,
            max_tokens=max_tokens,
            params={},
        )

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
