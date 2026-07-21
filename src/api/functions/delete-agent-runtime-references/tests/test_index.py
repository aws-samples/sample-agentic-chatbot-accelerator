# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the delete-agent-runtime-references config-bundle delete path."""

from unittest.mock import MagicMock

import index
import pytest
from botocore.exceptions import ClientError


@pytest.fixture
def bac(monkeypatch):
    """Replace the module-level control-plane client with a mock."""
    mock = MagicMock()
    monkeypatch.setattr(index, "BAC_CLIENT", mock)
    return mock


def test_deletes_bundle_by_id(bac):
    bac.delete_configuration_bundle.return_value = {
        "bundleId": "bundle-1",
        "status": "DELETING",
    }

    result = index.handler({"agentName": "my-agent", "bundleId": "bundle-1"}, None)

    bac.delete_configuration_bundle.assert_called_once_with(bundleId="bundle-1")
    assert result["status"] == 200
    assert result["body"]["deletedBundleId"] == "bundle-1"


def test_missing_bundle_is_idempotent_success(bac):
    bac.delete_configuration_bundle.side_effect = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "gone"}},
        "DeleteConfigurationBundle",
    )

    result = index.handler({"agentName": "my-agent", "bundleId": "bundle-1"}, None)

    bac.delete_configuration_bundle.assert_called_once_with(bundleId="bundle-1")
    assert result["status"] == 200
    assert result["body"]["deletedBundleId"] == "bundle-1"


def test_no_bundle_id_is_noop(bac):
    result = index.handler({"agentName": "legacy-agent"}, None)

    bac.delete_configuration_bundle.assert_not_called()
    assert result["status"] == 200
    assert result["body"]["deletedBundleId"] is None


def test_empty_bundle_id_is_noop(bac):
    # The SFN passes '' when the summary row carries no BundleId.
    result = index.handler({"agentName": "legacy-agent", "bundleId": ""}, None)

    bac.delete_configuration_bundle.assert_not_called()
    assert result["status"] == 200


def test_other_client_error_returns_400(bac):
    bac.delete_configuration_bundle.side_effect = ClientError(
        {"Error": {"Code": "ConflictException", "Message": "busy"}},
        "DeleteConfigurationBundle",
    )

    result = index.handler({"agentName": "my-agent", "bundleId": "bundle-1"}, None)

    assert result["status"] == 400
    assert result["body"]["deletedBundleId"] is None


def test_unexpected_error_returns_500(bac):
    bac.delete_configuration_bundle.side_effect = RuntimeError("boom")

    result = index.handler({"agentName": "my-agent", "bundleId": "bundle-1"}, None)

    assert result["status"] == 500
