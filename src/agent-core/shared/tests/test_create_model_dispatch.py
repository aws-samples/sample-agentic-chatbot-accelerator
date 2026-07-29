# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Routing matrix for BaseAgentFactory.create_model provider dispatch.

`mantle_support.is_on_mantle` and the two Mantle builders are mocked so the
tests assert *which* branch runs, and the non-Mantle branch still passes the
exact BedrockModel kwargs (caching + reasoning) it did before routing existed.

Run with:
    pytest shared/tests/test_create_model_dispatch.py -v
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from shared.base_factory import BaseAgentFactory
from shared.stream_types import ReasoningEffort


@pytest.fixture(autouse=True)
def _region(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    # Ensure the cross-account branch stays off by default.
    monkeypatch.delenv("bedrockAccessRoleArn", raising=False)


# --------------------------------------------------------------------------- #
# Mantle branches
# --------------------------------------------------------------------------- #
def test_mantle_oss_routes_to_openai_chat_builder():
    """OSS tail (incl. openai.gpt-oss-*) -> Chat Completions, NOT the Responses branch."""
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=True):
        with (
            patch.object(BaseAgentFactory, "_build_openai_mantle") as openai_builder,
            patch.object(
                BaseAgentFactory, "_build_openai_responses_mantle"
            ) as responses_builder,
            patch.object(
                BaseAgentFactory, "_build_anthropic_mantle"
            ) as anthropic_builder,
            patch("shared.base_factory.BedrockModel") as bedrock_cls,
        ):
            result = BaseAgentFactory.create_model(
                model_id="openai.gpt-oss-20b",
                max_tokens=512,
                temperature=0.7,
                reasoning_budget=ReasoningEffort.HIGH,
            )

    openai_builder.assert_called_once_with(
        "openai.gpt-oss-20b", 512, 0.7, ReasoningEffort.HIGH
    )
    responses_builder.assert_not_called()
    anthropic_builder.assert_not_called()
    bedrock_cls.assert_not_called()
    assert result is openai_builder.return_value


def test_mantle_openai_gpt5_routes_to_responses_builder():
    """openai.gpt-5.* -> Responses passthrough, NOT Chat Completions."""
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=True):
        with (
            patch.object(BaseAgentFactory, "_build_openai_mantle") as openai_builder,
            patch.object(
                BaseAgentFactory, "_build_openai_responses_mantle"
            ) as responses_builder,
            patch.object(
                BaseAgentFactory, "_build_anthropic_mantle"
            ) as anthropic_builder,
            patch("shared.base_factory.BedrockModel") as bedrock_cls,
        ):
            result = BaseAgentFactory.create_model(
                model_id="openai.gpt-5.4",
                max_tokens=512,
                temperature=0.7,
                reasoning_budget=ReasoningEffort.HIGH,
            )

    responses_builder.assert_called_once_with(
        "openai.gpt-5.4", 512, 0.7, ReasoningEffort.HIGH
    )
    openai_builder.assert_not_called()
    anthropic_builder.assert_not_called()
    bedrock_cls.assert_not_called()
    assert result is responses_builder.return_value


def test_mantle_anthropic_routes_to_anthropic_builder():
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=True):
        with (
            patch.object(BaseAgentFactory, "_build_openai_mantle") as openai_builder,
            patch.object(
                BaseAgentFactory, "_build_anthropic_mantle"
            ) as anthropic_builder,
            patch("shared.base_factory.BedrockModel") as bedrock_cls,
        ):
            result = BaseAgentFactory.create_model(
                model_id="anthropic.claude-haiku-4-5",
                max_tokens=1024,
                temperature=0.5,
            )

    anthropic_builder.assert_called_once_with(
        "anthropic.claude-haiku-4-5", 1024, 0.5, None
    )
    openai_builder.assert_not_called()
    bedrock_cls.assert_not_called()
    assert result is anthropic_builder.return_value


# --------------------------------------------------------------------------- #
# Non-Mantle branch → unchanged BedrockModel (Converse path)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "model_id",
    [
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "amazon.nova-lite-v1:0",
    ],
)
def test_non_mantle_routes_to_bedrock(model_id):
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=False):
        with (
            patch.object(BaseAgentFactory, "_build_openai_mantle") as openai_builder,
            patch.object(
                BaseAgentFactory, "_build_anthropic_mantle"
            ) as anthropic_builder,
            patch("shared.base_factory.BedrockModel") as bedrock_cls,
        ):
            result = BaseAgentFactory.create_model(
                model_id=model_id,
                max_tokens=256,
                temperature=0.3,
            )

    bedrock_cls.assert_called_once()
    openai_builder.assert_not_called()
    anthropic_builder.assert_not_called()
    assert result is bedrock_cls.return_value


def test_non_mantle_bedrock_kwargs_unchanged_for_caching_reasoning_model():
    """A caching + reasoning Anthropic Converse id keeps its exact model_args."""
    model_id = "anthropic.claude-sonnet-4-6"
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=False):
        with patch("shared.base_factory.BedrockModel") as bedrock_cls:
            BaseAgentFactory.create_model(
                model_id=model_id,
                max_tokens=2048,
                temperature=0.9,
                stop_sequences=["STOP"],
                enable_caching=True,
                reasoning_budget=ReasoningEffort.HIGH,
            )

    _, kwargs = bedrock_cls.call_args
    assert kwargs["model_id"] == model_id
    assert kwargs["max_tokens"] == 2048
    assert kwargs["stop_sequences"] == ["STOP"]
    # sonnet-4-6 supports caching and takes an effort-based reasoning budget:
    # an adaptive thinking block paired with an output_config effort.
    assert kwargs["cache_prompt"] == "default"
    assert kwargs["additional_request_fields"] == {
        "output_config": {"effort": "high"},
        "thinking": {"type": "adaptive"},
    }
    # Reasoning-enabled Anthropic Converse models drop temperature by design.
    assert "temperature" not in kwargs


# --------------------------------------------------------------------------- #
# Converse reasoning shapes, derived from stream_types.REASONING_CAPABILITIES
# --------------------------------------------------------------------------- #
def _converse_kwargs(model_id: str, **overrides):
    """Build a model on the Converse path and return the BedrockModel kwargs."""
    call_args = {
        "model_id": model_id,
        "max_tokens": 1024,
        "temperature": 0.7,
        **overrides,
    }
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=False):
        with patch("shared.base_factory.BedrockModel") as bedrock_cls:
            BaseAgentFactory.create_model(**call_args)

    _, kwargs = bedrock_cls.call_args
    return kwargs


@pytest.mark.parametrize(
    "effort",
    [
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
    ],
)
def test_converse_anthropic_maps_every_accepted_effort(effort):
    """Opus 5 accepts the full ladder incl. xhigh/max; each reaches output_config."""
    kwargs = _converse_kwargs(
        "us.anthropic.claude-opus-5-v1:0", reasoning_budget=effort
    )

    assert kwargs["additional_request_fields"] == {
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": effort.value},
    }
    assert "temperature" not in kwargs


@pytest.mark.parametrize(
    "effort",
    [ReasoningEffort.LOW, ReasoningEffort.MEDIUM, ReasoningEffort.HIGH],
)
def test_converse_nova_maps_effort_to_reasoning_config(effort):
    """Nova takes reasoningConfig with an explicit maxReasoningEffort."""
    kwargs = _converse_kwargs("us.amazon.nova-2-lite-v1:0", reasoning_budget=effort)

    assert kwargs["additional_request_fields"] == {
        "reasoningConfig": {
            "type": "enabled",
            "maxReasoningEffort": effort.value,
        }
    }


def test_converse_nova_high_drops_temperature():
    """The Nova 2 card: temperature/topP/topK cannot be combined with
    ``maxReasoningEffort`` — sending both errors at the provider. Regression test
    for the live bug this task fixes.
    """
    kwargs = _converse_kwargs(
        "us.amazon.nova-2-lite-v1:0", reasoning_budget=ReasoningEffort.HIGH
    )

    assert "reasoningConfig" in kwargs["additional_request_fields"]
    assert "temperature" not in kwargs


@pytest.mark.parametrize(
    "effort",
    [ReasoningEffort.LOW, ReasoningEffort.MEDIUM, ReasoningEffort.HIGH],
)
def test_converse_nova_drops_temperature_at_every_effort(effort):
    """Deliberately broader than the card, which scopes the conflict to ``high``:
    a knowing simplification that keeps this branch uniform with Anthropic's.
    """
    kwargs = _converse_kwargs("us.amazon.nova-2-lite-v1:0", reasoning_budget=effort)

    assert "temperature" not in kwargs


def test_converse_non_reasoning_claude_gets_no_reasoning_fields():
    """haiku-4-5 has no capability entry: a budget must not be attached anywhere.

    ``ModelConfiguration`` rejects this combination upstream, so reaching
    ``create_model`` with it is a programming error — but it must fail closed
    rather than smuggling the value into an unrelated request field.
    """
    kwargs = _converse_kwargs(
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        reasoning_budget=ReasoningEffort.HIGH,
    )

    assert "additional_request_fields" not in kwargs
    # Sampling control is untouched when no reasoning shape applies.
    assert kwargs["temperature"] == 0.7


def test_converse_reasoning_capable_but_non_converse_shape_attaches_nothing():
    """gpt-oss is reachable on Converse *and* has a capability entry, but only the
    Claude/Nova wire formats exist on this path.

    ``ModelConfiguration`` accepts a budget here (the table is keyed by model, not
    by branch), so this combination is reachable. The budget is dropped rather
    than guessed at — documenting the gap, not endorsing it. Effort for gpt-oss
    only takes effect on the Mantle Chat Completions branch.
    """
    kwargs = _converse_kwargs(
        "openai.gpt-oss-20b-1:0", reasoning_budget=ReasoningEffort.HIGH
    )

    assert "additional_request_fields" not in kwargs
    assert kwargs["temperature"] == 0.7


def test_converse_non_reasoning_model_args_unchanged_without_budget():
    """No-regression check: a non-reasoning model with no budget is untouched."""
    kwargs = _converse_kwargs("zai.glm-5", reasoning_budget=None)

    assert kwargs == {
        "model_id": "zai.glm-5",
        "max_tokens": 1024,
        "temperature": 0.7,
    }
