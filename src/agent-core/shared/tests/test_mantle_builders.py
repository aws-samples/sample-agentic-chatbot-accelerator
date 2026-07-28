# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the Mantle builder helpers on BaseAgentFactory (T2).

The Strands model constructors (`OpenAIModel`, `AnthropicModel`) are patched as
attributes on `strands.models`, which both records the kwargs and short-circuits
the lazy `__getattr__` in `strands.models.__init__` that would otherwise
`import openai` / `import anthropic` (SDKs that only ship in the model-building
containers, added in T4).

Run with:
    pytest shared/tests/test_mantle_builders.py -v
"""

from __future__ import annotations

import contextlib
from unittest.mock import MagicMock, patch

import pytest
import strands.models
from shared.base_factory import BaseAgentFactory
from shared.stream_types import ReasoningEffort

# Converse-only kwargs that must never reach a Mantle builder's constructor.
_CONVERSE_ONLY_KWARGS = {
    "cache_prompt",
    "additional_request_fields",
    "stop_sequences",
    "boto_session",
}


@contextlib.contextmanager
def _patched_model(name: str, mock: MagicMock):
    """Set a real attribute on `strands.models` and remove it afterwards.

    `patch.object` / `monkeypatch.setattr` both `getattr` the target first,
    which triggers the lazy `__getattr__` in `strands.models.__init__` →
    `import openai` / `import anthropic` (absent locally, added in T4). A plain
    `setattr` installs a real attribute that shadows `__getattr__`, so the
    builder's `from strands.models import <name>` resolves to the mock without
    importing the SDK.
    """
    setattr(strands.models, name, mock)
    try:
        yield mock
    finally:
        delattr(strands.models, name)


@pytest.fixture(autouse=True)
def _region(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-west-2")


# --------------------------------------------------------------------------- #
# _build_openai_mantle
# --------------------------------------------------------------------------- #
def test_build_openai_mantle_wires_params_and_mantle_config():
    openai_cls = MagicMock(name="OpenAIModel")
    with _patched_model("OpenAIModel", openai_cls):
        BaseAgentFactory._build_openai_mantle(
            model_id="openai.gpt-oss-20b",
            max_tokens=512,
            temperature=0.7,
        )

    openai_cls.assert_called_once_with(
        model_id="openai.gpt-oss-20b",
        params={"max_tokens": 512, "temperature": 0.7},
        bedrock_mantle_config={"region": "us-west-2"},
    )


def test_build_openai_mantle_maps_reasoning_effort_enum():
    openai_cls = MagicMock(name="OpenAIModel")
    with _patched_model("OpenAIModel", openai_cls):
        BaseAgentFactory._build_openai_mantle(
            model_id="openai.gpt-oss-20b",
            max_tokens=512,
            temperature=0.7,
            reasoning_budget=ReasoningEffort.HIGH,
        )

    _, kwargs = openai_cls.call_args
    assert kwargs["params"]["reasoning_effort"] == "high"


def test_build_openai_mantle_no_converse_only_kwargs():
    openai_cls = MagicMock(name="OpenAIModel")
    with _patched_model("OpenAIModel", openai_cls):
        BaseAgentFactory._build_openai_mantle(
            model_id="openai.gpt-oss-20b",
            max_tokens=512,
            temperature=0.7,
            reasoning_budget=ReasoningEffort.MEDIUM,
        )

    _, kwargs = openai_cls.call_args
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs)
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs["params"])
    # The reasoning effort is mapped to the OpenAI-style enum string.
    assert kwargs["params"]["reasoning_effort"] == "medium"


@pytest.mark.parametrize(
    "model_id",
    ["google.gemma-4-31b", "google.gemma-4-e2b", "xai.grok-4.3"],
)
def test_build_openai_mantle_openai_v1_models_use_passthrough_client_args(model_id):
    """gemma-4-* / grok-4.* take Chat Completions on /openai/v1 via client_args.

    strands' bedrock_mantle_config can't target /openai/v1 for these (its prefix
    set is openai.gpt-5.* only), so the builder injects base_url + minted token
    itself and MUST NOT pass bedrock_mantle_config.
    """
    openai_cls = MagicMock(name="OpenAIModel")
    with _patched_model("OpenAIModel", openai_cls):
        with patch(
            "shared.base_factory.mantle_support.mint_token", return_value="tok"
        ) as mint:
            BaseAgentFactory._build_openai_mantle(
                model_id=model_id,
                max_tokens=512,
                temperature=0.7,
            )

    mint.assert_called_once_with("us-west-2")
    _, kwargs = openai_cls.call_args
    assert kwargs["client_args"] == {
        "base_url": "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
        "api_key": "tok",
    }
    assert "bedrock_mantle_config" not in kwargs
    assert kwargs["model_id"] == model_id
    assert kwargs["params"] == {"max_tokens": 512, "temperature": 0.7}


def test_build_openai_mantle_oss_still_uses_bedrock_mantle_config():
    """The /v1 OSS tail keeps the turnkey bedrock_mantle_config (per-request mint)."""
    openai_cls = MagicMock(name="OpenAIModel")
    with _patched_model("OpenAIModel", openai_cls):
        with patch("shared.base_factory.mantle_support.mint_token") as mint:
            BaseAgentFactory._build_openai_mantle(
                model_id="openai.gpt-oss-20b",
                max_tokens=512,
                temperature=0.7,
            )

    # No self-minted token on the /v1 path; strands mints per request.
    mint.assert_not_called()
    _, kwargs = openai_cls.call_args
    assert kwargs["bedrock_mantle_config"] == {"region": "us-west-2"}
    assert "client_args" not in kwargs


# --------------------------------------------------------------------------- #
# _build_anthropic_mantle
# --------------------------------------------------------------------------- #
def test_build_anthropic_mantle_wires_client_args_and_max_tokens():
    anthropic_cls = MagicMock(name="AnthropicModel")
    with _patched_model("AnthropicModel", anthropic_cls):
        with patch(
            "shared.base_factory.mantle_support.mint_token", return_value="tok"
        ) as mint:
            BaseAgentFactory._build_anthropic_mantle(
                model_id="anthropic.claude-sonnet-5",
                max_tokens=1024,
                temperature=0.5,
            )

    mint.assert_called_once_with("us-west-2")
    anthropic_cls.assert_called_once_with(
        client_args={
            "base_url": "https://bedrock-mantle.us-west-2.api.aws/anthropic",
            "api_key": "tok",
        },
        model_id="anthropic.claude-sonnet-5",
        max_tokens=1024,
        params={},
    )


def test_build_anthropic_mantle_omits_temperature():
    """Claude >=4.7 (all Mantle-eligible Claude) 400s on non-default sampling."""
    anthropic_cls = MagicMock(name="AnthropicModel")
    with _patched_model("AnthropicModel", anthropic_cls):
        with patch("shared.base_factory.mantle_support.mint_token", return_value="tok"):
            BaseAgentFactory._build_anthropic_mantle(
                model_id="anthropic.claude-sonnet-5",
                max_tokens=1024,
                temperature=0.5,
                reasoning_budget=ReasoningEffort.HIGH,
            )

    _, kwargs = anthropic_cls.call_args
    assert "temperature" not in kwargs["params"]
    assert "temperature" not in kwargs


def test_build_anthropic_mantle_maps_reasoning_effort():
    """Effort reasoning maps to an adaptive thinking block + output_config effort."""
    anthropic_cls = MagicMock(name="AnthropicModel")
    with _patched_model("AnthropicModel", anthropic_cls):
        with patch("shared.base_factory.mantle_support.mint_token", return_value="tok"):
            BaseAgentFactory._build_anthropic_mantle(
                model_id="anthropic.claude-sonnet-5",
                max_tokens=1024,
                temperature=0.5,
                reasoning_budget=ReasoningEffort.HIGH,
            )

    _, kwargs = anthropic_cls.call_args
    assert kwargs["params"]["thinking"] == {"type": "adaptive"}
    assert kwargs["params"]["output_config"] == {"effort": "high"}


def test_build_anthropic_mantle_omits_reasoning_when_unset():
    """No reasoning_budget → no thinking/output_config keys in params."""
    anthropic_cls = MagicMock(name="AnthropicModel")
    with _patched_model("AnthropicModel", anthropic_cls):
        with patch("shared.base_factory.mantle_support.mint_token", return_value="tok"):
            BaseAgentFactory._build_anthropic_mantle(
                model_id="anthropic.claude-sonnet-5",
                max_tokens=1024,
                temperature=0.5,
            )

    _, kwargs = anthropic_cls.call_args
    assert kwargs["params"] == {}


def test_build_anthropic_mantle_no_converse_only_kwargs():
    anthropic_cls = MagicMock(name="AnthropicModel")
    with _patched_model("AnthropicModel", anthropic_cls):
        with patch("shared.base_factory.mantle_support.mint_token", return_value="tok"):
            BaseAgentFactory._build_anthropic_mantle(
                model_id="anthropic.claude-sonnet-5",
                max_tokens=1024,
                temperature=0.5,
            )

    _, kwargs = anthropic_cls.call_args
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs)
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs["params"])


# --------------------------------------------------------------------------- #
# _build_openai_responses_mantle (OpenAI gpt-5.* proprietary passthrough)
# --------------------------------------------------------------------------- #
# The builder imports `from strands.models.openai_responses import
# OpenAIResponsesModel`, so patch the name on that module.
_RESPONSES_TARGET = "strands.models.openai_responses.OpenAIResponsesModel"


def test_build_openai_responses_mantle_wires_params_and_mantle_config():
    with patch(_RESPONSES_TARGET) as responses_cls:
        BaseAgentFactory._build_openai_responses_mantle(
            model_id="openai.gpt-5.4",
            max_tokens=512,
            temperature=0.7,
        )

    # temperature is intentionally NOT sent: GPT-5.x on the Mantle Responses
    # surface 400s on it (T6 live finding). Only max_output_tokens is forwarded.
    responses_cls.assert_called_once_with(
        model_id="openai.gpt-5.4",
        params={"max_output_tokens": 512},
        bedrock_mantle_config={"region": "us-west-2"},
    )


def test_build_openai_responses_mantle_omits_temperature():
    """GPT-5.x rejects temperature on the Responses surface; must not be sent."""
    with patch(_RESPONSES_TARGET) as responses_cls:
        BaseAgentFactory._build_openai_responses_mantle(
            model_id="openai.gpt-5.4",
            max_tokens=512,
            temperature=0.5,
        )

    _, kwargs = responses_cls.call_args
    assert "temperature" not in kwargs["params"]
    assert "temperature" not in kwargs


def test_build_openai_responses_mantle_maps_reasoning_effort():
    with patch(_RESPONSES_TARGET) as responses_cls:
        BaseAgentFactory._build_openai_responses_mantle(
            model_id="openai.gpt-5.4",
            max_tokens=512,
            temperature=0.7,
            reasoning_budget=ReasoningEffort.HIGH,
        )

    _, kwargs = responses_cls.call_args
    assert kwargs["params"]["reasoning"] == {"effort": "high"}


def test_build_openai_responses_mantle_no_converse_only_kwargs():
    with patch(_RESPONSES_TARGET) as responses_cls:
        BaseAgentFactory._build_openai_responses_mantle(
            model_id="openai.gpt-5.4",
            max_tokens=512,
            temperature=0.7,
            reasoning_budget=ReasoningEffort.LOW,
        )

    _, kwargs = responses_cls.call_args
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs)
    assert not _CONVERSE_ONLY_KWARGS & set(kwargs["params"])
    # Responses uses max_output_tokens, never the Chat-Completions max_tokens.
    assert "max_tokens" not in kwargs["params"]
