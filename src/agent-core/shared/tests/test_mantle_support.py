# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for shared.mantle_support (T1).

Covers the success-only cache, empty-on-failure fallback with retry, exact-id
membership, base-URL shapes, and token minting. The network (`/v1/models`) and
`aws_bedrock_token_generator` are mocked so the module is testable without the
`openai` / token-generator deps that only ship in the model-building containers.

Run with:
    pytest shared/tests/test_mantle_support.py -v
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from shared import mantle_support

_CATALOG = frozenset({"openai.gpt-oss-20b", "openai.gpt-oss-120b", "qwen.qwen3-32b"})


@pytest.fixture(autouse=True)
def _clear_cache():
    """Reset the process-local catalog cache around every test."""
    mantle_support._reset_cache()
    yield
    mantle_support._reset_cache()


# --------------------------------------------------------------------------- #
# get_mantle_model_ids: caching + fallback + retry
# --------------------------------------------------------------------------- #
def test_get_mantle_model_ids_fetches_once_and_caches():
    with patch.object(
        mantle_support, "_fetch_model_ids", return_value=_CATALOG
    ) as fetch:
        first = mantle_support.get_mantle_model_ids()
        second = mantle_support.get_mantle_model_ids()

    assert first == _CATALOG
    assert second == _CATALOG
    fetch.assert_called_once()


def test_get_mantle_model_ids_empty_on_failure_and_logs_warning(caplog):
    with patch.object(
        mantle_support, "_fetch_model_ids", side_effect=RuntimeError("network down")
    ):
        with caplog.at_level("WARNING"):
            result = mantle_support.get_mantle_model_ids()

    assert result == frozenset()
    assert any(record.levelname == "WARNING" for record in caplog.records)


def test_get_mantle_model_ids_does_not_cache_failure_and_retries():
    with patch.object(
        mantle_support,
        "_fetch_model_ids",
        side_effect=[RuntimeError("transient blip"), _CATALOG],
    ) as fetch:
        first = mantle_support.get_mantle_model_ids()  # fails -> empty, not cached
        second = mantle_support.get_mantle_model_ids()  # retries -> success
        third = mantle_support.get_mantle_model_ids()  # now cached

    assert first == frozenset()
    assert second == _CATALOG
    assert third == _CATALOG
    assert fetch.call_count == 2  # third served from cache


def test_get_mantle_model_ids_caches_empty_success():
    """A legitimately empty catalog is a success and should be cached."""
    with patch.object(
        mantle_support, "_fetch_model_ids", return_value=frozenset()
    ) as fetch:
        mantle_support.get_mantle_model_ids()
        mantle_support.get_mantle_model_ids()

    fetch.assert_called_once()


# --------------------------------------------------------------------------- #
# is_on_mantle: exact-id membership, no normalization
# --------------------------------------------------------------------------- #
def test_is_on_mantle_exact_match():
    with patch.object(mantle_support, "_fetch_model_ids", return_value=_CATALOG):
        assert mantle_support.is_on_mantle("openai.gpt-oss-20b") is True
        assert (
            mantle_support.is_on_mantle("us.anthropic.claude-haiku-4-5-20251001-v1:0")
            is False
        )
        # Converse-form / inference-profile ids are absent from the Mantle list.
        assert mantle_support.is_on_mantle("openai.gpt-oss-20b-1:0") is False


# --------------------------------------------------------------------------- #
# base URLs
# --------------------------------------------------------------------------- #
def test_openai_base_url():
    assert (
        mantle_support.openai_base_url("us-west-2")
        == "https://bedrock-mantle.us-west-2.api.aws/v1"
    )


def test_anthropic_base_url():
    assert (
        mantle_support.anthropic_base_url("eu-central-1")
        == "https://bedrock-mantle.eu-central-1.api.aws/anthropic"
    )


# --------------------------------------------------------------------------- #
# mint_token: delegates to provide_token, wraps failures
# --------------------------------------------------------------------------- #
def _install_fake_token_generator(monkeypatch, provide_token):
    """Inject a fake aws_bedrock_token_generator module for the lazy import."""
    fake = types.ModuleType("aws_bedrock_token_generator")
    fake.provide_token = provide_token
    monkeypatch.setitem(sys.modules, "aws_bedrock_token_generator", fake)


def test_mint_token_delegates_to_provide_token(monkeypatch):
    provide_token = MagicMock(return_value="bedrock-api-key-abc&Version=1")
    _install_fake_token_generator(monkeypatch, provide_token)

    token = mantle_support.mint_token("us-east-1")

    assert token == "bedrock-api-key-abc&Version=1"
    provide_token.assert_called_once_with(region="us-east-1")


def test_mint_token_wraps_failure_as_runtime_error(monkeypatch):
    provide_token = MagicMock(side_effect=ValueError("no credentials"))
    _install_fake_token_generator(monkeypatch, provide_token)

    with pytest.raises(RuntimeError, match="Failed to mint a Bedrock bearer token"):
        mantle_support.mint_token("us-east-1")


# --------------------------------------------------------------------------- #
# _fetch_model_ids: OpenAI SDK wiring (client.models.list().data[*].id)
# --------------------------------------------------------------------------- #
def test_fetch_model_ids_wires_openai_client(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-west-2")

    model_a = types.SimpleNamespace(id="openai.gpt-oss-20b")
    model_b = types.SimpleNamespace(id="qwen.qwen3-32b")
    client = MagicMock()
    client.models.list.return_value = types.SimpleNamespace(data=[model_a, model_b])
    openai_cls = MagicMock(return_value=client)

    fake_openai = types.ModuleType("openai")
    fake_openai.OpenAI = openai_cls
    monkeypatch.setitem(sys.modules, "openai", fake_openai)

    with patch.object(mantle_support, "mint_token", return_value="tok") as mint:
        result = mantle_support._fetch_model_ids()

    assert result == frozenset({"openai.gpt-oss-20b", "qwen.qwen3-32b"})
    mint.assert_called_once_with("us-west-2")
    openai_cls.assert_called_once_with(
        base_url="https://bedrock-mantle.us-west-2.api.aws/v1",
        api_key="tok",
    )
