# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the swarm config loader sourcing config from bundles (T2 + T8).

Covers the top-level swarm config fetch from the bundle, fetch-failure
propagation, and the T8 change to sub-agent (agentReference) resolution: each
referenced sub-agent's config is read from its own bundle (summary row →
BundleId + QualifierToVersion versionId → get_configuration_bundle_version),
not from the removed runtime config table.

Run with:
    pytest tests/test_data_source.py -v
"""

import json
import logging
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from src.data_source import SwarmConfigurationLoader
from src.types import AgentReference

# Inline agents so parse_configuration does not trigger table-based resolution.
VALID_CONFIG = {
    "agents": [
        {
            "name": "researcher",
            "instructions": "You research things.",
            "modelInferenceParameters": {
                "modelId": "us.anthropic.claude-sonnet-4-6",
                "parameters": {"maxTokens": 4096, "temperature": 0.7},
            },
        }
    ],
    "entryAgent": "researcher",
}


SUB_AGENT_CONFIG = {
    "instructions": "You advocate for serverless.",
    "modelInferenceParameters": {
        "modelId": "us.anthropic.claude-sonnet-4-6",
        "parameters": {"maxTokens": 4096, "temperature": 0.7},
    },
    "tools": ["calculator"],
    "toolParameters": {},
    "mcpServers": [],
}


def _make_loader() -> SwarmConfigurationLoader:
    loader = SwarmConfigurationLoader.__new__(SwarmConfigurationLoader)
    loader._logger = logging.getLogger("test")
    loader._summary_table = None
    return loader


def test_parse_configuration_from_bundle():
    loader = _make_loader()
    with patch.object(
        loader, "_fetch_config_from_bundle", return_value=json.dumps(VALID_CONFIG)
    ) as fetch:
        cfg = loader.parse_configuration()

    fetch.assert_called_once_with(entity_type="swarm")
    assert cfg.entryAgent == "researcher"
    assert [a.name for a in cfg.agents] == ["researcher"]


def test_parse_configuration_propagates_fetch_error():
    loader = _make_loader()
    err = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
        "GetConfigurationBundleVersion",
    )
    with patch.object(loader, "_fetch_config_from_bundle", side_effect=err):
        with pytest.raises(ClientError):
            loader.parse_configuration()


def test_load_agent_config_resolves_sub_agent_from_bundle():
    """A referenced sub-agent is resolved via summary row → its own bundle."""
    loader = _make_loader()
    summary_table = MagicMock()
    summary_table.query.return_value = {
        "Items": [
            {
                "AgentName": "serverless_advocate",
                "BundleId": "serverless_advocate-abc123",
                "QualifierToVersion": {"DEFAULT": "ver-42"},
            }
        ]
    }
    loader._summary_table = summary_table
    ref = AgentReference(agentName="serverless_advocate", endpointName="DEFAULT")

    with patch.object(
        loader, "_fetch_config_from_bundle", return_value=json.dumps(SUB_AGENT_CONFIG)
    ) as fetch:
        agent_def = loader._load_agent_config(ref)

    # Fetched from the sub-agent's OWN bundle/version, keyed by its agent id.
    fetch.assert_called_once_with(
        bundle_id="serverless_advocate-abc123",
        bundle_version="ver-42",
        component_key="serverless_advocate",
        entity_type="sub-agent",
    )
    assert agent_def.name == "serverless_advocate"
    assert agent_def.tools == ["calculator"]


def test_load_agent_config_missing_bundle_id_raises():
    loader = _make_loader()
    summary_table = MagicMock()
    summary_table.query.return_value = {
        "Items": [
            {
                "AgentName": "serverless_advocate",
                "QualifierToVersion": {"DEFAULT": "ver-42"},
            }
        ]
    }
    loader._summary_table = summary_table
    ref = AgentReference(agentName="serverless_advocate", endpointName="DEFAULT")

    with pytest.raises(ValueError, match="no BundleId"):
        loader._load_agent_config(ref)


def test_load_agent_config_unknown_endpoint_raises():
    loader = _make_loader()
    summary_table = MagicMock()
    summary_table.query.return_value = {
        "Items": [
            {
                "AgentName": "serverless_advocate",
                "BundleId": "serverless_advocate-abc123",
                "QualifierToVersion": {"DEFAULT": "ver-42"},
            }
        ]
    }
    loader._summary_table = summary_table
    ref = AgentReference(agentName="serverless_advocate", endpointName="PROD")

    with pytest.raises(ValueError, match="no endpoint 'PROD'"):
        loader._load_agent_config(ref)
