# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the shared BaseConfigurationLoader bundle-fetch path (T1).

Run with:
    pytest shared/tests/test_base_data_source.py -v
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from shared.base_data_source import BaseConfigurationLoader


def _make_loader() -> BaseConfigurationLoader:
    """Build a loader without touching DynamoDB in __init__."""
    loader = BaseConfigurationLoader.__new__(BaseConfigurationLoader)
    loader._logger = logging.getLogger("test")
    return loader


def _bundle_response(config_value: str) -> dict:
    return {
        "bundleId": "agent-abc123",
        "versionId": "v1",
        "components": {
            "my-agent": {"configuration": {"ConfigurationValue": config_value}}
        },
    }


def test_fetch_config_from_bundle_returns_configuration_value():
    client = MagicMock()
    client.get_configuration_bundle_version.return_value = _bundle_response('{"k": 1}')

    loader = _make_loader()
    with patch("shared.base_data_source.boto3.client", return_value=client):
        result = loader._fetch_config_from_bundle(
            bundle_id="agent-abc123",
            bundle_version="v1",
            component_key="my-agent",
        )

    assert result == '{"k": 1}'
    client.get_configuration_bundle_version.assert_called_once_with(
        bundleId="agent-abc123", versionId="v1"
    )


def test_fetch_config_from_bundle_reads_env_vars(monkeypatch):
    monkeypatch.setenv("BUNDLE_ID", "agent-abc123")
    monkeypatch.setenv("BUNDLE_VERSION", "v1")
    monkeypatch.setenv("agentName", "my-agent")

    client = MagicMock()
    client.get_configuration_bundle_version.return_value = _bundle_response('{"k": 2}')

    loader = _make_loader()
    with patch("shared.base_data_source.boto3.client", return_value=client):
        result = loader._fetch_config_from_bundle()

    assert result == '{"k": 2}'
    client.get_configuration_bundle_version.assert_called_once_with(
        bundleId="agent-abc123", versionId="v1"
    )


def test_fetch_config_from_bundle_missing_component_raises():
    client = MagicMock()
    client.get_configuration_bundle_version.return_value = _bundle_response('{"k": 1}')

    loader = _make_loader()
    with patch("shared.base_data_source.boto3.client", return_value=client):
        with pytest.raises(ValueError, match="has no component"):
            loader._fetch_config_from_bundle(
                bundle_id="agent-abc123",
                bundle_version="v1",
                component_key="does-not-exist",
            )


def test_fetch_config_from_bundle_missing_configuration_value_raises():
    client = MagicMock()
    client.get_configuration_bundle_version.return_value = {
        "components": {"my-agent": {"configuration": {}}}
    }

    loader = _make_loader()
    with patch("shared.base_data_source.boto3.client", return_value=client):
        with pytest.raises(ValueError, match="no ConfigurationValue"):
            loader._fetch_config_from_bundle(
                bundle_id="agent-abc123",
                bundle_version="v1",
                component_key="my-agent",
            )


def test_fetch_config_from_bundle_propagates_client_error():
    client = MagicMock()
    client.get_configuration_bundle_version.side_effect = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
        "GetConfigurationBundleVersion",
    )

    loader = _make_loader()
    with patch("shared.base_data_source.boto3.client", return_value=client):
        with pytest.raises(ClientError):
            loader._fetch_config_from_bundle(
                bundle_id="agent-abc123",
                bundle_version="v1",
                component_key="my-agent",
            )
