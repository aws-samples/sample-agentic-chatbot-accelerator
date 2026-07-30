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
from .stream_types import ReasoningEffort, reasoning_capability_for

_cross_account_logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from logging import Logger

    from strands.models import AnthropicModel, OpenAIModel
    from strands.models.openai_responses import OpenAIResponsesModel

# Mantle model-id prefixes served on the OpenAI-proprietary passthrough
# (``/openai/v1``, Responses API) rather than the general Mantle surface
# (``/v1``, Chat Completions). This mirrors strands'
# ``strands.models._openai_bedrock._OPENAI_PATH_MODEL_PREFIXES``, which is the
# source of truth for the base-path decision — we duplicate the prefix only to
# pick the matching Strands class (OpenAIResponsesModel), since strands' config
# selects the path but not the API surface. Keep in sync if strands adds
# families (e.g. a future gpt-6). See AWS model cards: the openai/v1 path is
# "specific to the OpenAI models".
_MANTLE_OPENAI_RESPONSES_PREFIXES = ("openai.gpt-5.",)

# Mantle model-id prefixes served for **Chat Completions** on the OpenAI
# proprietary passthrough (``/openai/v1``) rather than the general Mantle Chat
# Completions surface (``/v1``). Unlike the Responses split above, strands'
# ``bedrock_mantle_config`` does NOT resolve these to ``/openai/v1`` — its
# ``_OPENAI_PATH_MODEL_PREFIXES`` only covers ``openai.gpt-5.*`` — so we build
# the client_args (base_url + token) ourselves for this set, the same way the
# Anthropic branch does. Determined empirically (2026-07-28): a full sweep of
# the Mantle catalog found exactly ``google.gemma-4-*`` and ``xai.grok-4.*``
# take Chat Completions on ``/openai/v1`` and reject ``/v1`` with
# ``400 "model isn't supported on this route"``. Keep in sync with the AWS
# model cards as new families land on this path.
_MANTLE_OPENAI_V1_CHAT_PREFIXES = ("google.gemma-4", "xai.grok-4.")

# Model-id fragments identifying which *request shape* a Converse-path reasoning
# request takes. Whether a model reasons at all — and at which effort levels — is
# owned by ``REASONING_CAPABILITIES`` in stream_types.py (the single capability
# table); these fragments only answer "which wire format", the same way
# ``_MANTLE_OPENAI_V1_CHAT_PREFIXES`` above only answers "which base path".
#
# Anthropic: adaptive ``thinking`` block + ``output_config.effort``.
# Nova: ``reasoningConfig={"type": "enabled", "maxReasoningEffort": ...}``.
_CONVERSE_ANTHROPIC_FRAGMENT = "claude"
_CONVERSE_NOVA_FRAGMENT = "nova"


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
        reasoning_budget: ReasoningEffort | None = None,
    ) -> Model:
        """Create the Strands model for ``model_id``, routing by Mantle membership.

        Dispatches by provider on an exact-id membership test against the Bedrock
        Mantle catalog:

        - not on Mantle → ``BedrockModel`` (the Converse path, unchanged).
        - on Mantle, ``anthropic.*`` → ``AnthropicModel`` (Mantle Messages API).
        - on Mantle, ``openai.gpt-5.*`` → ``OpenAIResponsesModel`` (the OpenAI
          proprietary passthrough: Responses API on ``/openai/v1``).
        - on Mantle, anything else → ``OpenAIModel`` (Mantle Chat Completions,
          ``/v1`` — the OSS tail incl. ``openai.gpt-oss-*``).

        The Converse-path arg assembly below (``model_args``, ``cache_prompt``,
        reasoning ``additional_request_fields``, ``stop_sequences``, cross-account
        ``boto_session``) is used only by the ``BedrockModel`` branch; for any
        ``model_id`` absent from the Mantle catalog, behavior is identical to
        before this routing was introduced. The membership check reads a
        process-cached set, so it adds no per-call network round-trip.

        Reasoning mapping per branch, all keyed off
        ``stream_types.reasoning_capability_for`` rather than a local allowlist:

        - Converse + Anthropic: ``thinking={"type": "adaptive"}`` plus
          ``output_config={"effort": ...}`` in ``additional_request_fields``;
          ``temperature`` is removed (thinking and sampling params are mutually
          exclusive).
        - Converse + Nova: ``reasoningConfig={"type": "enabled",
          "maxReasoningEffort": ...}``; ``temperature`` is removed too, per the
          Nova 2 card.
        - Mantle branches: delegated to the three ``_build_*_mantle`` helpers.

        A ``reasoning_budget`` for a model with no capability entry is a
        programming error by this point — ``ModelConfiguration`` rejects it
        upstream — so this method does not re-validate; it has no branch to apply
        and does not attach the parameter to an unrelated request field.

        Args:
            model_id (str): The configured model id (Converse-form or Mantle id).
            max_tokens (int): Maximum tokens for generation.
            temperature (float): Temperature for sampling.
            stop_sequences (list[str] | None): Converse-only stop sequences,
                passed to ``BedrockModel`` when provided and non-empty. Defaults
                to None.
            enable_caching (bool): Converse-only prompt caching, applied when the
                model supports it. Defaults to True.
            reasoning_budget (ReasoningEffort | None): Reasoning effort level,
                mapped per branch. ``None`` omits the parameter entirely;
                ``ReasoningEffort.NONE`` is sent as ``"none"`` and explicitly
                disables reasoning. Defaults to None.

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

        # Reasoning on the Converse path. Capability (does this model reason, and
        # at which levels?) is owned by ``reasoning_capability_for``; a budget for
        # a model with no entry is a programming error by this point because
        # ``ModelConfiguration`` already rejected it, so we do not re-validate —
        # we simply have no request shape to apply and MUST NOT attach the value
        # to an unrelated field. ``ReasoningEffort.NONE`` is a real value that has
        # to reach the provider (it is the only way to silence always-on models),
        # so there is deliberately no "skip when none" shortcut here.
        if (
            reasoning_budget is not None
            and reasoning_capability_for(model_id) is not None
        ):
            reasoning_val = reasoning_budget.value
            extra_fields: dict[str, Any] = {}

            if _CONVERSE_ANTHROPIC_FRAGMENT in model_id:
                # Adaptive thinking + an effort level. Sampling params are
                # mutually exclusive with thinking, so temperature is dropped.
                extra_fields["thinking"] = {"type": "adaptive"}
                extra_fields["output_config"] = {"effort": reasoning_val}
                model_args.pop("temperature", None)
            elif _CONVERSE_NOVA_FRAGMENT in model_id:
                extra_fields["reasoningConfig"] = {
                    "type": "enabled",
                    "maxReasoningEffort": reasoning_val,
                }
                # The Nova 2 card states temperature/topP/topK cannot be combined
                # with maxReasoningEffort (it errors). The card scopes that to
                # `high`; we drop temperature at *every* effort level anyway — a
                # knowing simplification that keeps this branch uniform with the
                # Anthropic one above, and a request opting into reasoning has
                # already traded away sampling control.
                model_args.pop("temperature", None)

                # Nova additionally rejects `maxTokens` at `high`:
                #   "`maxTokens` must be unset when reasoningConfig type is
                #    'enabled' and maxReasoningEffort is 'high'"
                # (ValidationException, verified live 2026-07-29). Unbounded
                # output is the provider's own requirement for this combination,
                # not a choice we get to make, so honour it rather than surface a
                # 400. Lower efforts keep max_tokens.
                if reasoning_budget is ReasoningEffort.HIGH:
                    model_args.pop("max_tokens", None)

            if extra_fields:
                model_args["additional_request_fields"] = extra_fields
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
        if model_id.startswith(_MANTLE_OPENAI_RESPONSES_PREFIXES):
            return BaseAgentFactory._build_openai_responses_mantle(
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
        reasoning_budget: ReasoningEffort | None = None,
    ) -> OpenAIModel:
        """Build an OpenAIModel routed through Bedrock Mantle (Chat Completions).

        Inference params go inside a ``params`` dict (OpenAIConfig shape), NOT as
        top-level kwargs the way BedrockModel takes them. MUST NOT pass any
        Converse-only arg (``cache_prompt``, ``additional_request_fields``,
        ``stop_sequences``, ``boto_session``).

        **Base-path split.** Most Chat Completions models use the general ``/v1``
        surface, wired turnkey via ``bedrock_mantle_config`` (strands builds the
        base URL and mints a fresh bearer token *per request*). A minority
        (``_MANTLE_OPENAI_V1_CHAT_PREFIXES`` — ``google.gemma-4-*``,
        ``xai.grok-4.*``) are served only on the ``/openai/v1`` passthrough and
        ``400`` on ``/v1``; strands' ``bedrock_mantle_config`` cannot target that
        path for them (its prefix set is ``openai.gpt-5.*`` only), so we inject
        ``client_args`` (``base_url`` + a minted ``api_key``) ourselves, mirroring
        the Anthropic branch. Caveat: that path mints a *static* token at
        construction (no per-request re-mint) — same bounded-lifetime tradeoff
        noted on ``_build_anthropic_mantle``.

        Args:
            model_id (str): Mantle model id (e.g. ``"openai.gpt-oss-20b"``).
            max_tokens (int): Maximum tokens for generation.
            temperature (float): Sampling temperature.
            reasoning_budget (ReasoningEffort | None): When set, mapped to
                ``params["reasoning_effort"]`` as an OpenAI-style enum string.
                Accepted levels are per-model (see ``REASONING_CAPABILITIES``);
                ``"none"`` is sent, not omitted — it is the only way to disable
                reasoning on the always-on families. Defaults to None.

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
            params["reasoning_effort"] = reasoning_budget.value

        # Models on the /openai/v1 passthrough: build client_args ourselves,
        # since bedrock_mantle_config would resolve them to the wrong (/v1) path.
        if model_id.startswith(_MANTLE_OPENAI_V1_CHAT_PREFIXES):
            region = os.environ["AWS_REGION"]
            return OpenAIModel(
                client_args={
                    "base_url": mantle_support.openai_passthrough_base_url(region),
                    "api_key": mantle_support.mint_token(region),
                },
                model_id=model_id,
                params=params,
            )

        return OpenAIModel(
            model_id=model_id,
            params=params,
            bedrock_mantle_config={"region": os.environ["AWS_REGION"]},
        )

    @staticmethod
    def _build_openai_responses_mantle(
        model_id: str,
        max_tokens: int,
        temperature: float,
        reasoning_budget: ReasoningEffort | None = None,
    ) -> OpenAIResponsesModel:
        """Build an OpenAIResponsesModel routed through Bedrock Mantle (Responses API).

        The OpenAI proprietary models (``openai.gpt-5.*``) are served only on the
        Responses API at the ``/openai/v1`` passthrough — they reject Chat
        Completions. Endpoint wiring is turnkey via ``bedrock_mantle_config``:
        strands resolves the ``/openai/v1`` base path for these ids (see
        ``strands.models._openai_bedrock``) and mints a fresh bearer token per
        request. Params use the Responses shape (``max_output_tokens``, not
        ``max_tokens``). MUST NOT pass any Converse-only arg (``cache_prompt``,
        ``additional_request_fields``, ``stop_sequences``, ``boto_session``).

        ``temperature`` is deliberately NOT forwarded: the GPT-5.x reasoning
        models on the Mantle Responses surface reject it with
        ``400 unsupported_parameter: 'temperature' is not supported with this
        model`` (observed live in T6 for ``openai.gpt-5.6-luna`` and
        ``openai.gpt-5.5``). This mirrors the Anthropic branch, which also omits
        sampling params for the newest models.

        Args:
            model_id (str): Mantle model id (e.g. ``"openai.gpt-5.4"``).
            max_tokens (int): Maximum tokens for generation, passed as the
                Responses-API ``max_output_tokens``.
            temperature (float): Sampling temperature. Accepted for a uniform
                builder signature but intentionally not sent (see above).
            reasoning_budget (ReasoningEffort | None): When set, mapped to
                ``params["reasoning"] = {"effort": <level>, "summary": "auto"}``.
                Accepted levels are per-model (GPT-5.6 documents all six);
                ``"none"`` is sent, not omitted. Defaults to None.

        Returns:
            OpenAIResponsesModel: Model configured for the Mantle Responses surface.
        """
        # Import lazily: strands.models.openai_responses does `import openai` at
        # module top; the openai SDK ships only in the model-building containers.
        # A top-level import would break `import base_factory` where it is absent.
        from strands.models.openai_responses import OpenAIResponsesModel

        params: dict[str, Any] = {
            "max_output_tokens": max_tokens,
        }
        # `summary: "auto"` is required to surface reasoning text. The Responses
        # API reasons privately by default and emits no reasoning events; opting
        # into a summary makes it stream `response.reasoning_summary_text.delta`
        # chunks, which the strands adapter maps to reasoningContent.text and the
        # AfterModelCallEvent hook (accumulate_reasoning) then captures. This is
        # the Responses-surface analogue of the Anthropic branch's
        # `display: "summarized"`: visibility-only (no cost/latency change), and
        # the raw chain of thought is never returned — the summary is the ceiling.
        if reasoning_budget is not None:
            params["reasoning"] = {"effort": reasoning_budget.value, "summary": "auto"}

        return OpenAIResponsesModel(
            model_id=model_id,
            params=params,
            bedrock_mantle_config={"region": os.environ["AWS_REGION"]},
        )

    @staticmethod
    def _build_anthropic_mantle(
        model_id: str,
        max_tokens: int,
        temperature: float,
        reasoning_budget: ReasoningEffort | None = None,
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
        sampling params entirely.

        Reasoning is expressed as an **effort level** on the newest Claude
        models: the Messages API takes an adaptive ``thinking`` block paired with
        an ``output_config`` effort — the same shape the Converse path assembles
        for Claude ids. Accepted levels are per-model (``xhigh``/``max`` are
        Opus-only) and enforced upstream by ``ModelConfiguration`` against
        ``REASONING_CAPABILITIES``. Both keys are forwarded through ``params``;
        enabling thinking is itself the reason ``temperature`` must be omitted.
        Integer token budgets are not supported (see ``ReasoningEffort``).

        The ``thinking`` block also sets ``display: "summarized"``. Without it
        the Messages API defaults to ``"omitted"`` on the newest Claude models —
        thinking blocks stream with empty ``text`` (signature only), so nothing
        reaches the reasoning-capture path. ``"summarized"`` is visibility-only
        (no cost/latency change); the raw chain of thought is never returned.

        MUST NOT pass any Converse-only arg (``cache_prompt``,
        ``additional_request_fields``, ``stop_sequences``, ``boto_session``).

        Args:
            model_id (str): Mantle model id (e.g. ``"anthropic.claude-sonnet-5"``).
            max_tokens (int): Maximum tokens for generation (required).
            temperature (float): Sampling temperature. Accepted for a uniform
                builder signature but intentionally not sent (see above).
            reasoning_budget (ReasoningEffort | None): When set, mapped to an
                adaptive ``thinking`` block plus ``output_config`` effort in
                ``params``. Defaults to None.

        Returns:
            AnthropicModel: Model configured for the Mantle Messages surface.
        """
        # Import lazily: strands.models.anthropic does `import anthropic` at
        # module top; the anthropic SDK only ships in the model-building
        # containers (see T4). Mirrors the OpenAI branch above.
        from strands.models import AnthropicModel

        region = os.environ["AWS_REGION"]

        # Effort-based reasoning via the native Messages shape: an adaptive
        # thinking block + output_config effort (verified against anthropic SDK
        # 0.109.1 ThinkingConfigAdaptiveParam + OutputConfigParam). strands
        # spreads params verbatim into the request body.
        #
        # `display: "summarized"` is required to surface reasoning text. On the
        # newest Claude models the Messages API defaults thinking display to
        # "omitted" — thinking blocks stream with an empty `text` and only a
        # signature, so downstream reasoning capture (accumulate_reasoning /
        # _extract_reasoning) sees nothing. Opting into "summarized" makes the
        # API emit thinking_delta chunks with summary text, which strands maps
        # to reasoningContent.text. This is visibility-only: thinking runs and
        # is billed identically either way, and the raw chain of thought is
        # never returned (the summary is the ceiling on this effort path).
        params: dict[str, Any] = {}
        if reasoning_budget is not None:
            params["thinking"] = {"type": "adaptive", "display": "summarized"}
            params["output_config"] = {"effort": reasoning_budget.value}

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
            params=params,
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
