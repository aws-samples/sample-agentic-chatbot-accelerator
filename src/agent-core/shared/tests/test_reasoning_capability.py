# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the per-model reasoning capability table (T1).

Covers the table's invariants, the longest-fragment lookup, per-model validation
in `ModelConfiguration`, a parametrized sweep over every model in the us-east-1
region catalog — the regression net for the whole reasoning story — and a drift
check against the frontend's hand-written mirror (T3).

Run with:
    pytest shared/tests/test_reasoning_capability.py -v
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import ValidationError
from shared.stream_types import (
    REASONING_CAPABILITIES,
    InferenceConfig,
    ModelConfiguration,
    ReasoningEffort,
    reasoning_capability_for,
)


def _config(model_id: str, budget: str | None) -> ModelConfiguration:
    """Build a ModelConfiguration, letting validation errors propagate."""
    return ModelConfiguration(
        modelId=model_id,
        parameters=InferenceConfig(maxTokens=1024, temperature=0.5),
        reasoningBudget=budget,
    )


# --------------------------------------------------------------------------- #
# Table invariants
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("fragment", sorted(REASONING_CAPABILITIES))
def test_no_entry_is_both_undisableable_and_offers_none(fragment: str):
    """`can_disable=False` and `NONE` in `efforts` are contradictory."""
    capability = REASONING_CAPABILITIES[fragment]
    if not capability.can_disable:
        assert ReasoningEffort.NONE not in capability.efforts, (
            f"{fragment}: reasoning cannot be disabled, so 'none' must not be "
            f"offered as an effort value"
        )


@pytest.mark.parametrize("fragment", sorted(REASONING_CAPABILITIES))
def test_every_entry_offers_at_least_one_effort(fragment: str):
    """An entry with no accepted values would reject everything."""
    assert REASONING_CAPABILITIES[fragment].efforts


@pytest.mark.parametrize("fragment", sorted(REASONING_CAPABILITIES))
def test_documented_defaults_are_themselves_accepted(fragment: str):
    """A default/recommended value the model would reject is incoherent."""
    capability = REASONING_CAPABILITIES[fragment]
    for label, effort in (
        ("default_effort", capability.default_effort),
        ("recommended_effort", capability.recommended_effort),
    ):
        if effort is not None:
            assert (
                effort in capability.efforts
            ), f"{fragment}: {label}={effort.value} is not in its own accepted set"


# --------------------------------------------------------------------------- #
# Lookup: longest fragment wins
# --------------------------------------------------------------------------- #


def test_gpt_56_keeps_its_six_levels():
    """The six-level set must not be narrowed by a shorter gpt-5 fragment."""
    capability = reasoning_capability_for("openai.gpt-5.6-luna")
    assert capability is not None
    assert ReasoningEffort.XHIGH in capability.efforts
    assert ReasoningEffort.MAX in capability.efforts
    assert ReasoningEffort.NONE in capability.efforts


def test_gpt_55_is_three_level():
    """GPT-5.5 documents only low/medium/high — it must not inherit 5.6's set."""
    capability = reasoning_capability_for("openai.gpt-5.5")
    assert capability is not None
    assert capability.efforts == {
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
    }


def test_geo_prefixed_and_bare_nova_ids_resolve_identically():
    """Substring matching must cover both inference-profile forms."""
    assert reasoning_capability_for(
        "us.amazon.nova-2-lite-v1:0"
    ) == reasoning_capability_for("amazon.nova-2-lite-v1:0")


def test_unknown_model_has_no_capability():
    assert reasoning_capability_for("zai.glm-5") is None
    assert reasoning_capability_for("some.model-that-does-not-exist") is None


# --------------------------------------------------------------------------- #
# Documented defaults (T3 prefills the picker from these)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "model_id,expected_default",
    [
        # Adaptive thinking: "At the default effort level (high)...".
        ("anthropic.claude-sonnet-5", ReasoningEffort.HIGH),
        ("anthropic.claude-opus-4-8", ReasoningEffort.HIGH),
        # Grok's card and launch blog both state low is the default.
        ("xai.grok-4.3", ReasoningEffort.LOW),
        # AWS publishes accepted values for these but never a default; the UI
        # must open unset rather than fabricating one.
        ("openai.gpt-5.6-luna", None),
        ("openai.gpt-5.5", None),
        ("openai.gpt-oss-20b", None),
        ("google.gemma-4-31b", None),
        # Off by default, so there is no default effort to report.
        ("us.amazon.nova-2-lite-v1:0", None),
    ],
)
def test_documented_default_effort(model_id: str, expected_default):
    capability = reasoning_capability_for(model_id)
    assert capability is not None
    assert capability.default_effort == expected_default


def test_gemma_4_e2b_recommends_high_but_has_no_default():
    """The card recommends high *because* E2B over-reasons — not a default."""
    capability = reasoning_capability_for("google.gemma-4-e2b")
    assert capability is not None
    assert capability.recommended_effort == ReasoningEffort.HIGH
    assert capability.default_effort is None


def test_only_gemma_4_e2b_carries_a_recommendation():
    with_recommendation = {
        fragment
        for fragment, capability in REASONING_CAPABILITIES.items()
        if capability.recommended_effort is not None
    }
    assert with_recommendation == {"gemma-4-e2b"}


# --------------------------------------------------------------------------- #
# Always-on models
# --------------------------------------------------------------------------- #


def test_sonnet_5_reasoning_cannot_be_disabled():
    """Card: "adaptive thinking is always on and cannot be disabled"."""
    capability = reasoning_capability_for("anthropic.claude-sonnet-5")
    assert capability is not None
    assert capability.can_disable is False


def test_sonnet_5_rejects_none():
    with pytest.raises(ValidationError, match="not accepted"):
        _config("anthropic.claude-sonnet-5", "none")


def test_grok_accepts_none_to_disable():
    """Grok reasons unless explicitly set to none, so none must be accepted."""
    assert _config("xai.grok-4.3", "none").reasoningBudget is ReasoningEffort.NONE


# --------------------------------------------------------------------------- #
# Per-model validation
# --------------------------------------------------------------------------- #


def test_opus_4_8_accepts_high_regression():
    """Opus 4.8 was rejected outright by the pre-T1 allowlist."""
    assert _config("anthropic.claude-opus-4-8", "high").reasoningBudget is (
        ReasoningEffort.HIGH
    )


def test_opus_4_8_accepts_xhigh_and_max():
    for effort in ("xhigh", "max"):
        assert _config("anthropic.claude-opus-4-8", effort).reasoningBudget.value == (
            effort
        )


def test_sonnet_5_rejects_xhigh_naming_accepted_values():
    """xhigh/max are Opus-only; the message must list what *is* accepted."""
    with pytest.raises(ValidationError) as excinfo:
        _config("anthropic.claude-sonnet-5", "xhigh")
    # Assert on the accepted-values clause specifically: pydantic echoes the
    # rejected input later in the message, so a substring check over the whole
    # string would find "xhigh" there regardless.
    assert "Accepted values: low, medium, high." in str(excinfo.value)


def test_gpt_55_rejects_xhigh():
    with pytest.raises(ValidationError, match="not accepted"):
        _config("openai.gpt-5.5", "xhigh")


def test_non_reasoning_model_rejected_with_unsupported_message():
    with pytest.raises(ValidationError, match="not supported for model"):
        _config("zai.glm-5", "low")


def test_qwen3_is_rejected_despite_supporting_reasoning():
    """Qwen3 reasons, but only via a /no_think prompt token — no API param."""
    with pytest.raises(ValidationError, match="not supported for model"):
        _config("qwen.qwen3-32b", "low")


def test_omitting_the_budget_is_always_valid():
    """None means "omit the parameter" and is never model-dependent."""
    for model_id in ("zai.glm-5", "anthropic.claude-sonnet-5", "qwen.qwen3-32b"):
        assert _config(model_id, None).reasoningBudget is None


# --------------------------------------------------------------------------- #
# Region-catalog sweep — the regression net
#
# Every model offered in us-east-1 (iac-cdk/lib/shared/supported-models.ts),
# with the capability the model-card sweep recorded (design-doc §1). Keep in
# sync when the region catalog changes.
# --------------------------------------------------------------------------- #

_LMH = frozenset({ReasoningEffort.LOW, ReasoningEffort.MEDIUM, ReasoningEffort.HIGH})
_OPUS = _LMH | {ReasoningEffort.XHIGH, ReasoningEffort.MAX}

# (model_id, expected accepted efforts or None when reasoning is unsupported)
_US_EAST_1_CATALOG: list[tuple[str, frozenset[ReasoningEffort] | None]] = [
    ("openai.gpt-5.6-luna", _OPUS | {ReasoningEffort.NONE}),
    ("openai.gpt-5.6-sol", _OPUS | {ReasoningEffort.NONE}),
    ("openai.gpt-5.6-terra", _OPUS | {ReasoningEffort.NONE}),
    ("openai.gpt-5.5", _LMH),
    ("openai.gpt-5.4", _LMH),
    ("openai.gpt-oss-20b", _LMH),
    ("openai.gpt-oss-120b", _LMH),
    ("anthropic.claude-sonnet-5", _LMH),
    ("anthropic.claude-opus-4-8", _OPUS),
    ("us.amazon.nova-2-lite-v1:0", _LMH),
    ("amazon.nova-2-sonic-v1:0", None),
    ("deepseek.v3.2", None),
    ("google.gemma-4-31b", _LMH),
    ("google.gemma-4-e2b", _LMH),
    ("google.gemma-4-26b-a4b", _LMH),
    ("google.gemma-3-4b-it", None),
    ("minimax.minimax-m2.5", None),
    ("mistral.mistral-large-3-675b-instruct", None),
    ("mistral.ministral-3-14b-instruct", None),
    ("mistral.ministral-3-8b-instruct", None),
    ("mistral.ministral-3-3b-instruct", None),
    ("moonshotai.kimi-k2.5", None),
    ("nvidia.nemotron-super-3-120b", None),
    # Qwen3 reasons but exposes no API parameter — excluded by design.
    ("qwen.qwen3-next-80b-a3b-instruct", None),
    ("qwen.qwen3-32b", None),
    ("qwen.qwen3-235b-a22b-2507", None),
    ("xai.grok-4.3", _LMH | {ReasoningEffort.NONE}),
    ("zai.glm-5", None),
    ("zai.glm-4.7-flash", None),
]


def test_catalog_sweep_covers_all_29_models():
    """Guard against a row being dropped from the sweep list."""
    assert len(_US_EAST_1_CATALOG) == 29
    assert len({model_id for model_id, _ in _US_EAST_1_CATALOG}) == 29


@pytest.mark.parametrize("model_id,expected_efforts", _US_EAST_1_CATALOG)
def test_catalog_model_capability_matches_sweep(model_id: str, expected_efforts):
    capability = reasoning_capability_for(model_id)
    if expected_efforts is None:
        assert capability is None, (
            f"{model_id} is recorded as having no controllable reasoning, but "
            f"resolved to {capability}"
        )
    else:
        assert capability is not None, f"{model_id} should support reasoning"
        assert capability.efforts == expected_efforts


@pytest.mark.parametrize("model_id,expected_efforts", _US_EAST_1_CATALOG)
def test_catalog_model_accepts_each_of_its_efforts(model_id: str, expected_efforts):
    """End-to-end: every advertised value parses; nothing else does."""
    if expected_efforts is None:
        return
    for effort in expected_efforts:
        assert _config(model_id, effort.value).reasoningBudget is effort
    for effort in set(ReasoningEffort) - set(expected_efforts):
        with pytest.raises(ValidationError, match="not accepted"):
            _config(model_id, effort.value)


# --------------------------------------------------------------------------- #
# Frontend mirror drift (T3)
#
# `wizard-utils.ts` hand-mirrors REASONING_CAPABILITIES because the browser
# cannot import Python. Nothing generates it, so this parses the TS source and
# fails the build when the two tables disagree — on fragments, accepted effort
# values, can_disable, default_effort or recommended_effort.
#
# Parsing the TS rather than importing it is the same tactic
# `iac-cdk/test/aca.test.ts` uses for `aws-exports.json`: the file is not valid
# JSON, but the one declaration we care about is regular enough to read with a
# regex. If this parser ever fails to find the table, that is a test failure too
# (see test_mirror_parser_found_a_table) — a silently empty parse would make
# every comparison below vacuously true.
# --------------------------------------------------------------------------- #

_WIZARD_UTILS_TS = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "user-interface"
    / "react-app"
    / "src"
    / "components"
    / "wizard"
    / "wizard-utils.ts"
)

# `const EFFORT_LMH = ["low", "medium", "high"];`
_TS_ALIAS_RE = re.compile(r"^const (EFFORT_[A-Z0-9_]+) = (\[[^\]]*\]);", re.MULTILINE)
_TS_TABLE_RE = re.compile(
    r"export const REASONING_CAPABILITIES: Record<string, ReasoningCapability> = \{"
    r"(?P<body>.*?)^\};",
    re.DOTALL | re.MULTILINE,
)
# One `"fragment": { ... }` entry. The entry bodies contain no nested braces, so
# a brace-free inner match is enough to delimit them.
_TS_ENTRY_RE = re.compile(r'"(?P<fragment>[^"]+)":\s*\{(?P<body>[^{}]*)\}')
_TS_STRING_RE = re.compile(r'"([^"]*)"')


def _strip_line_comments(source: str) -> str:
    """Drop `//` comments so their prose cannot be mistaken for syntax."""
    return re.sub(r"^\s*//.*$", "", source, flags=re.MULTILINE)


def _parse_ts_effort_list(expression: str, aliases: dict[str, list[str]]) -> list[str]:
    """Resolve a TS array expression of string literals and `...ALIAS` spreads.

    Args:
        expression (str): e.g. `["none", ...EFFORT_LMH]` or a bare `EFFORT_LMH`.
        aliases (dict[str, list[str]]): Already-resolved alias arrays.

    Returns:
        list[str]: The effort values in source order.
    """
    expression = expression.strip()
    if expression in aliases:
        return list(aliases[expression])

    values: list[str] = []
    # Split on commas at the top level; the elements are all literals or spreads.
    for element in expression.strip("[]").split(","):
        element = element.strip()
        if not element:
            continue
        if element.startswith("..."):
            values.extend(aliases[element[3:].strip()])
        else:
            literal = _TS_STRING_RE.fullmatch(element)
            assert literal, f"unparsed effort element in TS mirror: {element!r}"
            values.append(literal.group(1))
    return values


def _parse_ts_mirror() -> dict[str, dict[str, object]]:
    """Parse REASONING_CAPABILITIES out of wizard-utils.ts.

    Returns:
        dict[str, dict[str, object]]: fragment -> {efforts, canDisable,
            defaultEffort, recommendedEffort}, with efforts in source order.
    """
    assert _WIZARD_UTILS_TS.is_file(), f"missing frontend mirror: {_WIZARD_UTILS_TS}"
    source = _strip_line_comments(_WIZARD_UTILS_TS.read_text(encoding="utf-8"))

    aliases: dict[str, list[str]] = {}
    for name, expression in _TS_ALIAS_RE.findall(source):
        # Aliases may spread earlier aliases, so resolve in declaration order.
        aliases[name] = _parse_ts_effort_list(expression, aliases)

    table_match = _TS_TABLE_RE.search(source)
    assert table_match, "could not locate REASONING_CAPABILITIES in wizard-utils.ts"

    mirror: dict[str, dict[str, object]] = {}
    for entry in _TS_ENTRY_RE.finditer(table_match.group("body")):
        body = entry.group("body")

        efforts_match = re.search(r"efforts:\s*(\[[^\]]*\]|EFFORT_[A-Z0-9_]+)", body)
        assert efforts_match, f"{entry.group('fragment')}: no efforts in TS mirror"

        can_disable_match = re.search(r"canDisable:\s*(true|false)", body)
        assert (
            can_disable_match
        ), f"{entry.group('fragment')}: no canDisable in TS mirror"

        default_match = re.search(r'defaultEffort:\s*"([^"]+)"', body)
        recommended_match = re.search(r'recommendedEffort:\s*"([^"]+)"', body)

        mirror[entry.group("fragment")] = {
            "efforts": _parse_ts_effort_list(efforts_match.group(1), aliases),
            "canDisable": can_disable_match.group(1) == "true",
            "defaultEffort": default_match.group(1) if default_match else None,
            "recommendedEffort": (
                recommended_match.group(1) if recommended_match else None
            ),
        }
    return mirror


_TS_MIRROR = _parse_ts_mirror()


def test_mirror_parser_found_a_table():
    """A parser that silently found nothing would pass every drift check."""
    assert len(_TS_MIRROR) == len(REASONING_CAPABILITIES) > 0
    assert all(entry["efforts"] for entry in _TS_MIRROR.values())


def test_mirror_covers_exactly_the_same_fragments():
    """A fragment added to one table and not the other is drift."""
    assert set(_TS_MIRROR) == set(REASONING_CAPABILITIES), (
        f"only in Python: {sorted(set(REASONING_CAPABILITIES) - set(_TS_MIRROR))}; "
        f"only in TS: {sorted(set(_TS_MIRROR) - set(REASONING_CAPABILITIES))}"
    )


@pytest.mark.parametrize("fragment", sorted(REASONING_CAPABILITIES))
def test_mirror_matches_python_entry(fragment: str):
    """Every field the UI reads must agree with the backend's table."""
    if fragment not in _TS_MIRROR:
        pytest.fail(f"{fragment} is missing from the wizard-utils.ts mirror")

    expected = REASONING_CAPABILITIES[fragment]
    actual = _TS_MIRROR[fragment]

    assert set(actual["efforts"]) == {
        effort.value for effort in expected.efforts
    }, f"{fragment}: accepted efforts drifted"
    assert (
        actual["canDisable"] is expected.can_disable
    ), f"{fragment}: canDisable drifted"
    assert actual["defaultEffort"] == (
        expected.default_effort.value if expected.default_effort else None
    ), f"{fragment}: defaultEffort drifted"
    assert actual["recommendedEffort"] == (
        expected.recommended_effort.value if expected.recommended_effort else None
    ), f"{fragment}: recommendedEffort drifted"


@pytest.mark.parametrize("fragment", sorted(_TS_MIRROR))
def test_mirror_effort_order_is_stable_for_display(fragment: str):
    """The picker must not reshuffle as the user switches models.

    The TS mirror keeps efforts as an ordered array (Python uses an unordered
    frozenset), so the order is the frontend's own invariant: `none` first, then
    low -> max, matching ReasoningEffort's declaration order.
    """
    declaration_order = [effort.value for effort in ReasoningEffort]
    efforts = _TS_MIRROR[fragment]["efforts"]
    assert isinstance(efforts, list)
    assert efforts == [value for value in declaration_order if value in efforts], (
        f"{fragment}: efforts are out of display order ({efforts}); expected the "
        f"ReasoningEffort declaration order {declaration_order}"
    )
