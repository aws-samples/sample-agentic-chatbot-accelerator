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
def test_mantle_non_anthropic_routes_to_openai_builder():
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=True):
        with (
            patch.object(BaseAgentFactory, "_build_openai_mantle") as openai_builder,
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
    anthropic_builder.assert_not_called()
    bedrock_cls.assert_not_called()
    assert result is openai_builder.return_value


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
    model_id = "anthropic.claude-3-7-sonnet-20250219-v1:0"
    with patch("shared.base_factory.mantle_support.is_on_mantle", return_value=False):
        with patch("shared.base_factory.BedrockModel") as bedrock_cls:
            BaseAgentFactory.create_model(
                model_id=model_id,
                max_tokens=2048,
                temperature=0.9,
                stop_sequences=["STOP"],
                enable_caching=True,
                reasoning_budget=4096,
            )

    _, kwargs = bedrock_cls.call_args
    assert kwargs["model_id"] == model_id
    assert kwargs["max_tokens"] == 2048
    assert kwargs["stop_sequences"] == ["STOP"]
    # 3.7-sonnet supports caching and takes an integer reasoning budget.
    assert kwargs["cache_prompt"] == "default"
    assert kwargs["additional_request_fields"] == {
        "thinking": {"type": "enabled", "budget_tokens": 4096}
    }
    # Reasoning-enabled Anthropic Converse models drop temperature by design.
    assert "temperature" not in kwargs
