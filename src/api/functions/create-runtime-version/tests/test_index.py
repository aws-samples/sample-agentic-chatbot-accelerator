# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the create-runtime-version Lambda config-bundle env wiring."""

from unittest.mock import MagicMock

import index
import pytest

BASE_EVENT = {
    "agentName": "my-agent",
    "agentCfg": {"systemPrompt": "hi", "useMemory": False},
    "bundleId": "bundle-123",
    "versionId": "v1",
}


@pytest.fixture
def bac_client(monkeypatch):
    """Replace the module-level control-plane client with a MagicMock.

    A brand-new runtime is simulated: list returns no match (create path), and
    create returns version '1'.
    """
    client = MagicMock()
    client.list_agent_runtimes.return_value = {"agentRuntimes": [], "nextToken": None}
    client.create_agent_runtime.return_value = {
        "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/r-1",
        "agentRuntimeId": "r-1",
        "agentRuntimeVersion": "1",
    }
    monkeypatch.setattr(index, "BAC_CLIENT", client)
    return client


def _env_of_last_create(client) -> dict:
    """Return the environmentVariables map from the create call."""
    return client.create_agent_runtime.call_args.kwargs["environmentVariables"]


def test_http_env_has_bundle_pointers(bac_client):
    index.handler({**BASE_EVENT, "protocol": "HTTP"}, None)

    env = _env_of_last_create(bac_client)
    assert env["BUNDLE_ID"] == "bundle-123"
    assert env["BUNDLE_VERSION"] == "v1"
    # agentName stays — it is the bundle component key (ADR-0002).
    assert env["agentName"] == "my-agent"
    # createdAt is no longer a container env var (config keyed by bundle).
    assert "createdAt" not in env


def test_a2a_env_has_bundle_pointers(bac_client):
    index.handler({**BASE_EVENT, "protocol": "A2A"}, None)

    env = _env_of_last_create(bac_client)
    assert env["BUNDLE_ID"] == "bundle-123"
    assert env["BUNDLE_VERSION"] == "v1"
    assert env["agentName"] == "my-agent"
    assert "createdAt" not in env


def test_created_at_still_returned_in_body(bac_client):
    """createdAt is dropped from container env but still surfaced for the SFN."""
    result = index.handler({**BASE_EVENT, "protocol": "HTTP", "createdAt": 42}, None)
    assert result["body"]["createdAt"] == 42


def test_bundle_id_is_required(bac_client):
    """The input model now requires bundleId/versionId (supplied by the SFN)."""
    with pytest.raises(Exception):
        index.handler(
            {"agentName": "my-agent", "agentCfg": {}, "protocol": "HTTP"}, None
        )
