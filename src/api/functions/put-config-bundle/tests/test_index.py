# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the put-config-bundle Lambda (mocked control plane)."""

from unittest.mock import MagicMock

import index
import pytest
from botocore.exceptions import ClientError

CONFIG_JSON = '{"systemPrompt": "hi", "modelId": "anthropic.claude-x"}'


@pytest.fixture
def bac_client(monkeypatch):
    """Replace the module-level control-plane client with a MagicMock."""
    client = MagicMock()
    monkeypatch.setattr(index, "BAC_CLIENT", client)
    return client


def test_create_path_returns_new_bundle_ids(bac_client):
    bac_client.create_configuration_bundle.return_value = {
        "bundleId": "bundle-123",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1234:bundle/bundle-123",
        "versionId": "v1",
        "createdAt": "2026-07-21T00:00:00Z",
    }

    result = index.handler(
        {"agentName": "my-agent", "configurationValue": CONFIG_JSON}, None
    )

    assert result == {
        "bundleId": "bundle-123",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1234:bundle/bundle-123",
        "versionId": "v1",
    }
    # Create is used (no bundleId), update is not.
    bac_client.create_configuration_bundle.assert_called_once()
    bac_client.update_configuration_bundle.assert_not_called()

    kwargs = bac_client.create_configuration_bundle.call_args.kwargs
    # Sanitized name (hyphen -> underscore) and single-blob component.
    assert kwargs["bundleName"] == "my_agent"
    assert kwargs["components"] == {
        "my-agent": {"configuration": {"ConfigurationValue": CONFIG_JSON}}
    }
    assert "clientToken" in kwargs  # idempotency token present


def test_update_path_passes_parent_version_ids(bac_client):
    bac_client.update_configuration_bundle.return_value = {
        "bundleId": "bundle-123",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1234:bundle/bundle-123",
        "versionId": "v2",
        "updatedAt": "2026-07-21T00:00:00Z",
    }

    result = index.handler(
        {
            "agentName": "my-agent",
            "configurationValue": CONFIG_JSON,
            "bundleId": "bundle-123",
            "parentVersionId": "v1",
            "commitMessage": "bump",
        },
        None,
    )

    assert result["versionId"] == "v2"
    bac_client.update_configuration_bundle.assert_called_once()
    bac_client.create_configuration_bundle.assert_not_called()

    kwargs = bac_client.update_configuration_bundle.call_args.kwargs
    assert kwargs["bundleId"] == "bundle-123"
    assert kwargs["parentVersionIds"] == ["v1"]
    assert kwargs["commitMessage"] == "bump"
    # Update path must not send a bundleName.
    assert "bundleName" not in kwargs


def test_update_path_defaults_commit_message_when_absent(bac_client):
    # UpdateConfigurationBundle rejects component updates without a
    # commitMessage; the create SFN doesn't pass one, so the handler must
    # default it rather than let the update fail.
    bac_client.update_configuration_bundle.return_value = {
        "bundleId": "bundle-123",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1234:bundle/bundle-123",
        "versionId": "v2",
        "updatedAt": "2026-07-21T00:00:00Z",
    }

    index.handler(
        {
            "agentName": "my-agent",
            "configurationValue": CONFIG_JSON,
            "bundleId": "bundle-123",
            "parentVersionId": "v1",
        },
        None,
    )

    kwargs = bac_client.update_configuration_bundle.call_args.kwargs
    assert kwargs["commitMessage"]  # non-empty default supplied
    assert "my-agent" in kwargs["commitMessage"]


def test_update_without_parent_version_raises(bac_client):
    with pytest.raises(ValueError, match="parentVersionId is required"):
        index.handler(
            {
                "agentName": "my-agent",
                "configurationValue": CONFIG_JSON,
                "bundleId": "bundle-123",
            },
            None,
        )
    bac_client.update_configuration_bundle.assert_not_called()


def test_client_error_propagates(bac_client):
    bac_client.create_configuration_bundle.side_effect = ClientError(
        {"Error": {"Code": "ValidationException", "Message": "bad"}},
        "CreateConfigurationBundle",
    )
    with pytest.raises(ClientError):
        index.handler(
            {"agentName": "my-agent", "configurationValue": CONFIG_JSON}, None
        )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("my-agent", "my_agent"),  # hyphen -> underscore
        ("123agent", "a_123agent"),  # leading digit -> prefixed letter
        ("_leading", "a__leading"),  # leading underscore -> prefixed letter
        ("", "a_"),  # empty -> valid minimal name
        ("valid_Name1", "valid_Name1"),  # already valid, unchanged
        ("dots.and spaces!", "dots_and_spaces_"),  # arbitrary chars -> underscore
    ],
)
def test_sanitize_bundle_name(raw, expected):
    assert index.sanitize_bundle_name(raw) == expected


def test_sanitize_bundle_name_truncates():
    result = index.sanitize_bundle_name("a" * 200)
    assert len(result) == index.BUNDLE_NAME_MAX
