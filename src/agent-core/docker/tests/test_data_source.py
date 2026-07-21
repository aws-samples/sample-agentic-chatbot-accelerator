# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the single-agent config loader sourcing from a bundle (T2).

Run with:
    pytest tests/test_data_source.py -v
"""

import json
import logging
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from src.data_source import AgentConfigurationLoader

VALID_CONFIG = {
    "modelInferenceParameters": {
        "modelId": "us.anthropic.claude-sonnet-4-6",
        "parameters": {"maxTokens": 4096, "temperature": 0.7},
    },
    "instructions": "You are a helpful assistant.",
    "tools": [],
    "toolParameters": {},
    "mcpServers": [],
}


def _make_loader() -> AgentConfigurationLoader:
    loader = AgentConfigurationLoader.__new__(AgentConfigurationLoader)
    loader._logger = logging.getLogger("test")
    return loader


def test_parse_configuration_from_bundle():
    loader = _make_loader()
    with patch.object(
        loader, "_fetch_config_from_bundle", return_value=json.dumps(VALID_CONFIG)
    ) as fetch:
        cfg = loader.parse_configuration()

    fetch.assert_called_once_with(entity_type="agent")
    assert cfg.instructions == "You are a helpful assistant."
    assert cfg.modelInferenceParameters.modelId == "us.anthropic.claude-sonnet-4-6"


def test_parse_configuration_propagates_fetch_error():
    loader = _make_loader()
    err = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
        "GetConfigurationBundleVersion",
    )
    with patch.object(loader, "_fetch_config_from_bundle", side_effect=err):
        with pytest.raises(ClientError):
            loader.parse_configuration()
