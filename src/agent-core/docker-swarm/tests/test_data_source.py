# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the swarm config loader sourcing the top-level config from a bundle (T2).

Sub-agent resolution (summary/agents tables) is unchanged and covered elsewhere;
these tests only assert the top-level swarm config is fetched from the bundle and
that fetch failures propagate.

Run with:
    pytest tests/test_data_source.py -v
"""

import json
import logging
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from src.data_source import SwarmConfigurationLoader

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


def _make_loader() -> SwarmConfigurationLoader:
    loader = SwarmConfigurationLoader.__new__(SwarmConfigurationLoader)
    loader._logger = logging.getLogger("test")
    loader._agents_table = None
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
