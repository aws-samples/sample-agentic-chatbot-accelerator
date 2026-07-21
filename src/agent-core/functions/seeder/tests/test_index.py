# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the agentcore seeder config-bundle write path."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import index
import pytest

CONFIG_JSON = '{"systemPrompt": "hi", "modelId": "anthropic.claude-x"}'

# Minimal Lambda context for @logger.inject_lambda_context.
LAMBDA_CTX = SimpleNamespace(
    function_name="seeder",
    memory_limit_in_mb=128,
    invoked_function_arn="arn:aws:lambda:us-east-1:1:function:seeder",
    aws_request_id="req-1",
)


def _event(request_type: str = "Create", config_hash: str = "hash-1") -> dict:
    return {
        "RequestType": request_type,
        "ResourceProperties": {
            "item": json.dumps(
                {
                    "AgentName": "default-agent",
                    "CreatedAt": 123,
                    "AgentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/r",
                    "AgentRuntimeId": "r-1",
                    "AgentRuntimeVersion": "1",
                    "ConfigurationValue": CONFIG_JSON,
                }
            ),
            "configHash": config_hash,
        },
    }


@pytest.fixture
def clients(monkeypatch):
    """Replace the module-level DynamoDB table and control-plane client."""
    table = MagicMock()
    bac = MagicMock()
    monkeypatch.setattr(index, "DASHBOARD_TABLE", table)
    monkeypatch.setattr(index, "BAC_CLIENT", bac)
    return table, bac


def test_create_path_new_agent(clients):
    table, bac = clients
    # No prior summary row → create a new bundle.
    table.get_item.return_value = {}
    bac.create_configuration_bundle.return_value = {
        "bundleId": "bundle-1",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1:bundle/bundle-1",
        "versionId": "v1",
    }

    index.handler(_event(), LAMBDA_CTX)

    bac.create_configuration_bundle.assert_called_once()
    bac.update_configuration_bundle.assert_not_called()
    kwargs = bac.create_configuration_bundle.call_args.kwargs
    assert kwargs["bundleName"] == "default_agent"  # hyphen -> underscore
    assert kwargs["components"] == {
        "default-agent": {"configuration": {"ConfigurationValue": CONFIG_JSON}}
    }

    # New agent → put_item with bundle fields, no runtime-config-table write.
    table.put_item.assert_called_once()
    item = table.put_item.call_args.kwargs["Item"]
    assert item["BundleId"] == "bundle-1"
    assert item["BundleArn"] == "arn:aws:bedrock-agentcore:us-east-1:1:bundle/bundle-1"
    assert item["QualifierToVersion"] == {"DEFAULT": "v1"}
    assert item["ConfigHash"] == "hash-1"


def test_update_path_existing_agent_versions_bundle(clients):
    table, bac = clients
    # Prior row exists with a different hash and an existing bundle.
    table.get_item.return_value = {
        "Item": {
            "BundleId": "bundle-1",
            "QualifierToVersion": {"DEFAULT": "v1"},
            "ConfigHash": "old-hash",
        }
    }
    bac.update_configuration_bundle.return_value = {
        "bundleId": "bundle-1",
        "bundleArn": "arn:aws:bedrock-agentcore:us-east-1:1:bundle/bundle-1",
        "versionId": "v2",
    }

    index.handler(_event(request_type="Update", config_hash="new-hash"), LAMBDA_CTX)

    bac.update_configuration_bundle.assert_called_once()
    bac.create_configuration_bundle.assert_not_called()
    kwargs = bac.update_configuration_bundle.call_args.kwargs
    assert kwargs["bundleId"] == "bundle-1"
    assert kwargs["parentVersionIds"] == ["v1"]  # parent chained

    # Existing agent → update_item advancing QualifierToVersion + bundle fields.
    table.update_item.assert_called_once()
    values = table.update_item.call_args.kwargs["ExpressionAttributeValues"]
    assert values[":ver"] == "v2"
    assert values[":bid"] == "bundle-1"
    assert values[":hash"] == "new-hash"


def test_idempotent_unchanged_hash_skips_bundle(clients):
    table, bac = clients
    # Prior row with the SAME hash as the incoming event → no-op.
    table.get_item.return_value = {"Item": {"ConfigHash": "hash-1", "BundleId": "b1"}}

    index.handler(_event(config_hash="hash-1"), LAMBDA_CTX)

    bac.create_configuration_bundle.assert_not_called()
    bac.update_configuration_bundle.assert_not_called()
    table.put_item.assert_not_called()
    table.update_item.assert_not_called()


def test_delete_is_noop(clients):
    table, bac = clients
    index.handler(_event(request_type="Delete"), LAMBDA_CTX)
    bac.create_configuration_bundle.assert_not_called()
    bac.update_configuration_bundle.assert_not_called()
    table.get_item.assert_not_called()


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("default-agent", "default_agent"),
        ("123agent", "a_123agent"),
        ("valid_Name1", "valid_Name1"),
    ],
)
def test_sanitize_bundle_name(raw, expected):
    assert index.sanitize_bundle_name(raw) == expected
