# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the graph config loader sourcing the top-level config from a bundle (T2).

Sub-agent node resolution (summary/agents tables, factory ARN lookups) is
unchanged; these tests only assert the top-level graph config is fetched from the
bundle and that fetch failures propagate.

Run with:
    pytest tests/test_data_source.py -v
"""

import json
import logging
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from src.data_source import GraphConfigurationLoader

VALID_CONFIG = {
    "nodes": [{"id": "start", "agentName": "researcher"}],
    "edges": [{"source": "start", "target": "__end__"}],
    "entryPoint": "start",
}


def _make_loader() -> GraphConfigurationLoader:
    loader = GraphConfigurationLoader.__new__(GraphConfigurationLoader)
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

    fetch.assert_called_once_with(entity_type="graph")
    assert cfg.entryPoint == "start"
    assert [n.id for n in cfg.nodes] == ["start"]


def test_parse_configuration_propagates_fetch_error():
    loader = _make_loader()
    err = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
        "GetConfigurationBundleVersion",
    )
    with patch.object(loader, "_fetch_config_from_bundle", side_effect=err):
        with pytest.raises(ClientError):
            loader.parse_configuration()
