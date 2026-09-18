# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Judge-model routing in the evaluation-executor (T3).

The Strands model classes are patched and the judge kwargs asserted rather than
reaching the network, mirroring shared/tests/test_create_model_dispatch.py. The
LLM evaluators are replaced in ``EvaluatorFactory.EVALUATOR_CLASSES``, so a case
reaches the scoring path without an inference call; the two tests that need a
real Strands model and a real evaluator stub only ``.evaluate``.

Run with:
    pytest src/api/functions/evaluation-executor/tests -v
"""

from __future__ import annotations

import contextlib
from unittest.mock import MagicMock, patch

import pytest
from evaluator import (
    JUDGE_MAX_TOKENS,
    JUDGE_TEMPERATURE,
    EvaluationRunner,
    EvaluatorFactory,
    StructuredOutputEvaluator,
)
from shared.base_factory import BaseAgentFactory
from strands import models as strands_models
from strands_evals.types.evaluation import EvaluationOutput

from shared import mantle_support

_REGION = "us-west-2"
_PASS_THRESHOLD = 0.5
# Named rather than inlined so the scanner suppression sits on one line that black
# cannot reflow: as an inline literal, black wraps the assert and moves the pragma
# to the closing paren, leaving the string itself flagged.
_FAKE_MINTED_TOKEN = "mantle-token"  # pragma: allowlist secret  # not a credential

# The Responses builder does `from strands.models.openai_responses import
# OpenAIResponsesModel` inside the function, so the class is patched at its
# source module.
_RESPONSES_TARGET = "strands.models.openai_responses.OpenAIResponsesModel"

# Minimal trajectory for the evaluators that require one; an empty trace list
# still yields a session with one agent-invocation span.
_TRAJECTORY = {"session_id": "judge-session", "traces": []}


@pytest.fixture(autouse=True)
def _judge_env(monkeypatch):
    monkeypatch.setenv("AWS_REGION", _REGION)
    # This Lambda has no cross-account role (T4), so the Converse branch must
    # never attach a boto_session.
    monkeypatch.delenv("bedrockAccessRoleArn", raising=False)
    mantle_support._reset_cache()
    yield
    mantle_support._reset_cache()


@contextlib.contextmanager
def _patched_model_class(name: str, mock: MagicMock):
    """Install a real attribute on `strands.models`, shadowing its lazy import.

    `patch.object` getattrs the target first, which triggers the lazy
    `__getattr__` in `strands.models.__init__` → `import openai` / `anthropic`.
    A plain setattr resolves the builder's `from strands.models import <name>`
    to the mock without importing the SDK.
    """
    setattr(strands_models, name, mock)
    try:
        yield mock
    finally:
        delattr(strands_models, name)


@contextlib.contextmanager
def _mantle_catalog(*model_ids: str):
    """Pin the Mantle catalog; no ids means every id routes to Converse."""
    with patch.object(
        mantle_support, "get_mantle_model_ids", return_value=frozenset(model_ids)
    ):
        yield


@contextlib.contextmanager
def _stub_evaluator(evaluator_type: str, evaluate_side_effect=None):
    """Replace an evaluator class with a mock that scores without an LLM."""
    stub_cls = MagicMock(name=f"{evaluator_type}Stub")
    if evaluate_side_effect is not None:
        stub_cls.return_value.evaluate.side_effect = evaluate_side_effect
    else:
        stub_cls.return_value.evaluate.return_value = [
            EvaluationOutput(score=1.0, test_pass=True, reason="stubbed verdict")
        ]
    with patch.dict(EvaluatorFactory.EVALUATOR_CLASSES, {evaluator_type: stub_cls}):
        yield stub_cls


@contextlib.contextmanager
def _real_evaluator_without_inference(evaluator_type: str):
    """Build the real evaluator class, stubbing only its `.evaluate` call.

    Yields the list of instances built, so a test can inspect what the factory
    actually handed the SDK.
    """
    real_cls = EvaluatorFactory.EVALUATOR_CLASSES[evaluator_type]
    built = []

    def factory(*args, **kwargs):
        evaluator = real_cls(*args, **kwargs)
        evaluator.evaluate = MagicMock(
            return_value=[
                EvaluationOutput(score=1.0, test_pass=True, reason="stubbed verdict")
            ]
        )
        built.append(evaluator)
        return evaluator

    with patch.dict(EvaluatorFactory.EVALUATOR_CLASSES, {evaluator_type: factory}):
        yield built


def _judge_model_given_to(stub_cls: MagicMock):
    return stub_cls.call_args.kwargs["model"]


def _evaluate(runner: EvaluationRunner, evaluator_type: str, **overrides):
    kwargs = {
        "evaluator_type": evaluator_type,
        "input_text": "What is the capital of France?",
        "expected_output": "Paris",
        "actual_output": "Paris",
        "rubric": "Score factual correctness.",
        "case_name": "judge-routing-case",
    }
    kwargs.update(overrides)
    return runner.evaluate(**kwargs)


# --------------------------------------------------------------------------- #
# Mantle surfaces
# --------------------------------------------------------------------------- #
def test_mantle_gpt5_judge_reaches_the_responses_surface():
    model_id = "openai.gpt-5.6-terra"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)

    with _mantle_catalog(model_id), patch(_RESPONSES_TARGET) as responses_cls:
        with _stub_evaluator("OutputEvaluator") as stub_cls:
            result = _evaluate(runner, "OutputEvaluator")

    responses_cls.assert_called_once_with(
        model_id=model_id,
        params={"max_output_tokens": JUDGE_MAX_TOKENS},
        bedrock_mantle_config={"region": _REGION},
    )
    assert _judge_model_given_to(stub_cls) is responses_cls.return_value
    assert result.status == "scored"


def test_mantle_oss_judge_reaches_the_chat_completions_surface():
    model_id = "openai.gpt-oss-120b"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)
    openai_cls = MagicMock(name="OpenAIModel")

    with _mantle_catalog(model_id), _patched_model_class("OpenAIModel", openai_cls):
        with _stub_evaluator("OutputEvaluator") as stub_cls:
            result = _evaluate(runner, "OutputEvaluator")

    openai_cls.assert_called_once_with(
        model_id=model_id,
        params={"max_tokens": JUDGE_MAX_TOKENS, "temperature": JUDGE_TEMPERATURE},
        bedrock_mantle_config={"region": _REGION},
    )
    assert _judge_model_given_to(stub_cls) is openai_cls.return_value
    assert result.status == "scored"


def test_mantle_anthropic_judge_reaches_the_messages_surface():
    model_id = "anthropic.claude-haiku-4-5"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)
    anthropic_cls = MagicMock(name="AnthropicModel")

    with (
        _mantle_catalog(model_id),
        _patched_model_class("AnthropicModel", anthropic_cls),
    ):
        with patch.object(
            mantle_support, "mint_token", return_value=_FAKE_MINTED_TOKEN
        ):
            with _stub_evaluator("HelpfulnessEvaluator") as stub_cls:
                result = _evaluate(
                    runner, "HelpfulnessEvaluator", trajectory=_TRAJECTORY
                )

    _, kwargs = anthropic_cls.call_args
    assert kwargs["model_id"] == model_id
    assert kwargs["max_tokens"] == JUDGE_MAX_TOKENS
    assert kwargs["client_args"]["api_key"] == _FAKE_MINTED_TOKEN
    # FR8: no reasoning budget, so no thinking/output_config; this surface also
    # drops temperature outright.
    assert kwargs["params"] == {}
    assert "temperature" not in kwargs
    assert _judge_model_given_to(stub_cls) is anthropic_cls.return_value
    assert result.status == "scored"


def test_mantle_passthrough_chat_judge_forwards_the_pinned_temperature():
    model_id = "xai.grok-4.6"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)
    openai_cls = MagicMock(name="OpenAIModel")

    with _mantle_catalog(model_id), _patched_model_class("OpenAIModel", openai_cls):
        with patch.object(
            mantle_support, "mint_token", return_value=_FAKE_MINTED_TOKEN
        ):
            with _stub_evaluator("OutputEvaluator") as stub_cls:
                result = _evaluate(runner, "OutputEvaluator")

    _, kwargs = openai_cls.call_args
    assert kwargs["model_id"] == model_id
    assert kwargs["params"] == {
        "max_tokens": JUDGE_MAX_TOKENS,
        "temperature": JUDGE_TEMPERATURE,
    }
    assert kwargs["client_args"]["api_key"] == _FAKE_MINTED_TOKEN
    assert _judge_model_given_to(stub_cls) is openai_cls.return_value
    assert result.status == "scored"


@pytest.mark.parametrize(
    "model_id, on_mantle, expected_class",
    [
        ("openai.gpt-oss-120b", True, "OpenAIModel"),
        ("openai.gpt-5.6-terra", True, "OpenAIResponsesModel"),
        ("anthropic.claude-haiku-4-5", True, "AnthropicModel"),
        ("us.anthropic.claude-sonnet-4-20250514-v1:0", False, "BedrockModel"),
    ],
)
def test_the_evaluator_receives_a_real_model_instance_that_serializes_to_the_id(
    model_id, on_mantle, expected_class
):
    """End to end with the real model classes and a real evaluator: the judge is
    an instance, of the class its surface requires, and `to_dict` still records
    the configured id.
    """
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)
    catalog = (model_id,) if on_mantle else ()

    with _mantle_catalog(*catalog):
        with patch.object(
            mantle_support, "mint_token", return_value=_FAKE_MINTED_TOKEN
        ):
            with _real_evaluator_without_inference("HelpfulnessEvaluator") as built:
                result = _evaluate(
                    runner, "HelpfulnessEvaluator", trajectory=_TRAJECTORY
                )

    judge = built[0].model
    assert not isinstance(judge, str)
    assert type(judge).__name__ == expected_class
    assert built[0].to_dict()["model_id"] == model_id
    assert result.status == "scored"


# --------------------------------------------------------------------------- #
# Non-Mantle (Converse) path
# --------------------------------------------------------------------------- #
def test_non_mantle_judge_builds_bedrock_with_only_the_judge_kwargs():
    model_id = "us.anthropic.claude-3-5-sonnet-20240620-v1:0"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)

    with _mantle_catalog(), patch("shared.base_factory.BedrockModel") as bedrock_cls:
        with _stub_evaluator("OutputEvaluator") as stub_cls:
            result = _evaluate(runner, "OutputEvaluator")

    _, kwargs = bedrock_cls.call_args
    assert kwargs == {
        "model_id": model_id,
        "max_tokens": JUDGE_MAX_TOKENS,
        "temperature": JUDGE_TEMPERATURE,
    }
    assert _judge_model_given_to(stub_cls) is bedrock_cls.return_value
    assert result.status == "scored"


def test_non_mantle_judge_adds_no_cache_point_for_a_cache_capable_id():
    """A cache-capable Converse id keeps the pre-change kwargs: the string
    hand-off never produced a cache point.
    """
    model_id = "us.anthropic.claude-sonnet-4-20250514-v1:0"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)

    with _mantle_catalog(), patch("shared.base_factory.BedrockModel") as bedrock_cls:
        with _stub_evaluator("OutputEvaluator"):
            _evaluate(runner, "OutputEvaluator")

    _, kwargs = bedrock_cls.call_args
    assert "cache_prompt" not in kwargs


@pytest.mark.parametrize("model_id", ["", "vendor.not-a-real-model"])
def test_an_id_in_no_catalog_reaches_bedrock_verbatim(model_id):
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)

    with _mantle_catalog(), patch("shared.base_factory.BedrockModel") as bedrock_cls:
        with _stub_evaluator("OutputEvaluator"):
            _evaluate(runner, "OutputEvaluator")

    _, kwargs = bedrock_cls.call_args
    assert kwargs["model_id"] == model_id


def test_a_provider_rejection_of_the_judge_id_becomes_an_error_result():
    runner = EvaluationRunner(model_id="", pass_threshold=_PASS_THRESHOLD)

    with _mantle_catalog(), patch("shared.base_factory.BedrockModel"):
        with _stub_evaluator(
            "OutputEvaluator",
            evaluate_side_effect=RuntimeError(
                "ValidationException: invalid model identifier"
            ),
        ):
            result = _evaluate(runner, "OutputEvaluator")

    assert result.status == "error"
    assert result.evaluator_type == "OutputEvaluator"


# --------------------------------------------------------------------------- #
# Deterministic evaluators stay offline
# --------------------------------------------------------------------------- #
def test_a_structured_output_only_case_never_touches_bedrock_or_mantle():
    with (
        patch.object(BaseAgentFactory, "create_model") as create_model,
        patch.object(mantle_support, "get_mantle_model_ids") as catalog_fetch,
        patch.object(mantle_support, "mint_token") as mint_token,
    ):
        runner = EvaluationRunner(
            model_id="openai.gpt-oss-120b", pass_threshold=_PASS_THRESHOLD
        )
        result = _evaluate(
            runner,
            "StructuredOutputEvaluator",
            expected_output={"loop_id": "x22A-002"},
            actual_structured_output={"loop_id": "x22A-002"},
        )

    assert result.status == "scored"
    assert result.score == 1.0
    create_model.assert_not_called()
    catalog_fetch.assert_not_called()
    mint_token.assert_not_called()


def test_a_deterministic_evaluator_still_builds_with_no_model():
    evaluator = EvaluatorFactory.create_from_type(
        evaluator_type="StructuredOutputEvaluator",
        model_id="openai.gpt-oss-120b",
        pass_threshold=_PASS_THRESHOLD,
    )

    assert isinstance(evaluator, StructuredOutputEvaluator)


def test_a_skipped_evaluator_never_builds_a_model():
    with patch.object(BaseAgentFactory, "create_model") as create_model:
        runner = EvaluationRunner(
            model_id="anthropic.claude-haiku-4-5", pass_threshold=_PASS_THRESHOLD
        )
        result = _evaluate(runner, "HelpfulnessEvaluator", trajectory=None)

    assert result.status == "skipped"
    create_model.assert_not_called()


# --------------------------------------------------------------------------- #
# Construction: placement, count, failure isolation
# --------------------------------------------------------------------------- #
def test_the_runner_defers_model_construction_to_evaluate():
    """Constructing in `__init__` would move a token-mint or catalog failure
    outside evaluate()'s handler, failing the whole SQS record instead of one
    evaluator.
    """
    with patch.object(
        BaseAgentFactory, "create_model", side_effect=RuntimeError("token mint failed")
    ) as create_model:
        runner = EvaluationRunner(
            model_id="anthropic.claude-haiku-4-5", pass_threshold=_PASS_THRESHOLD
        )
        create_model.assert_not_called()

        with _stub_evaluator("HelpfulnessEvaluator"):
            result = _evaluate(runner, "HelpfulnessEvaluator", trajectory=_TRAJECTORY)

    assert create_model.call_count == 1
    assert result.status == "error"


def test_a_failed_judge_construction_yields_one_error_result_and_no_evaluator():
    runner = EvaluationRunner(
        model_id="anthropic.claude-haiku-4-5", pass_threshold=_PASS_THRESHOLD
    )

    with patch.object(
        BaseAgentFactory, "create_model", side_effect=RuntimeError("token mint failed")
    ):
        with _stub_evaluator("HelpfulnessEvaluator") as stub_cls:
            result = _evaluate(runner, "HelpfulnessEvaluator", trajectory=_TRAJECTORY)

    assert result.status == "error"
    assert result.evaluator_type == "HelpfulnessEvaluator"
    assert result.passed is False
    stub_cls.assert_not_called()


def test_two_evaluator_types_on_one_runner_share_one_judge_model():
    runner = EvaluationRunner(
        model_id="openai.gpt-oss-120b", pass_threshold=_PASS_THRESHOLD
    )
    judge = MagicMock(name="judge-model")

    with patch.object(
        BaseAgentFactory, "create_model", return_value=judge
    ) as create_model:
        with _stub_evaluator("OutputEvaluator") as output_stub:
            with _stub_evaluator("HelpfulnessEvaluator") as helpfulness_stub:
                first = _evaluate(runner, "OutputEvaluator")
                second = _evaluate(
                    runner, "HelpfulnessEvaluator", trajectory=_TRAJECTORY
                )

    assert create_model.call_count == 1
    assert _judge_model_given_to(output_stub) is judge
    assert _judge_model_given_to(helpfulness_stub) is judge
    assert (first.status, second.status) == ("scored", "scored")


def test_each_record_in_a_warm_container_builds_its_own_model_from_one_catalog_fetch():
    model_id = "openai.gpt-oss-120b"
    openai_cls = MagicMock(
        name="OpenAIModel", side_effect=lambda **kwargs: MagicMock(name="judge-model")
    )

    with patch.object(
        mantle_support, "_fetch_model_ids", return_value=frozenset([model_id])
    ) as catalog_fetch:
        with _patched_model_class("OpenAIModel", openai_cls):
            with _stub_evaluator("OutputEvaluator") as stub_cls:
                _evaluate(
                    EvaluationRunner(model_id, _PASS_THRESHOLD), "OutputEvaluator"
                )
                first_judge = _judge_model_given_to(stub_cls)
                _evaluate(
                    EvaluationRunner(model_id, _PASS_THRESHOLD), "OutputEvaluator"
                )
                second_judge = _judge_model_given_to(stub_cls)

    assert openai_cls.call_count == 2
    assert first_judge is not second_judge
    assert catalog_fetch.call_count == 1


# --------------------------------------------------------------------------- #
# Judge inference parameters
# --------------------------------------------------------------------------- #
def test_the_judge_parameters_are_pinned():
    assert JUDGE_TEMPERATURE == 0.0
    assert JUDGE_MAX_TOKENS == 4096


def test_the_judge_model_is_requested_with_the_pinned_parameters_and_no_reasoning():
    model_id = "anthropic.claude-haiku-4-5"
    runner = EvaluationRunner(model_id=model_id, pass_threshold=_PASS_THRESHOLD)

    with patch.object(BaseAgentFactory, "create_model") as create_model:
        with _stub_evaluator("OutputEvaluator"):
            _evaluate(runner, "OutputEvaluator")

    kwargs = create_model.call_args.kwargs
    assert kwargs["model_id"] == model_id
    assert kwargs["max_tokens"] == JUDGE_MAX_TOKENS
    assert kwargs["temperature"] == JUDGE_TEMPERATURE
    assert kwargs.get("reasoning_budget") is None
    assert create_model.call_args.args == ()


# --------------------------------------------------------------------------- #
# EvaluatorFactory fails closed
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("evaluator_type", ["OutputEvaluator", "HelpfulnessEvaluator"])
def test_an_llm_evaluator_without_a_model_raises_rather_than_using_the_id_string(
    evaluator_type,
):
    with _stub_evaluator(evaluator_type) as stub_cls:
        with pytest.raises(ValueError):
            EvaluatorFactory.create_from_type(
                evaluator_type=evaluator_type,
                model_id="openai.gpt-oss-120b",
                pass_threshold=_PASS_THRESHOLD,
                rubric="Score factual correctness.",
            )

    stub_cls.assert_not_called()


def test_an_unknown_evaluator_type_raises_value_error():
    with pytest.raises(ValueError):
        EvaluatorFactory.create_from_type(
            evaluator_type="NotAnEvaluator",
            model_id="openai.gpt-oss-120b",
            pass_threshold=_PASS_THRESHOLD,
            model=MagicMock(name="judge-model"),
        )
