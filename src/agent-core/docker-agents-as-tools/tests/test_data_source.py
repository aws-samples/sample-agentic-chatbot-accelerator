# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Tests for the orchestrator config loader sourcing from a bundle (T2).

Run with:
    pytest tests/test_data_source.py -v
"""

import json
import logging
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from src.data_source import OrchestratorConfigurationLoader

VALID_CONFIG = {
    "modelInferenceParameters": {
        "modelId": "us.anthropic.claude-sonnet-4-6",
        "parameters": {"maxTokens": 4096, "temperature": 0.7},
    },
    "instructions": "You are an orchestrator.",
    "agentsAsTools": [
        {
            "runtimeId": "arn:aws:bedrock-agentcore:...:runtime/sub",
            "endpoint": "DEFAULT",
        }
    ],
}


def _make_loader() -> OrchestratorConfigurationLoader:
    loader = OrchestratorConfigurationLoader.__new__(OrchestratorConfigurationLoader)
    loader._logger = logging.getLogger("test")
    return loader


def test_parse_configuration_from_bundle():
    loader = _make_loader()
    with patch.object(
        loader, "_fetch_config_from_bundle", return_value=json.dumps(VALID_CONFIG)
    ) as fetch:
        cfg = loader.parse_configuration()

    fetch.assert_called_once_with(entity_type="orchestrator")
    assert cfg.instructions == "You are an orchestrator."
    assert len(cfg.agentsAsTools) == 1


def test_parse_configuration_propagates_fetch_error():
    loader = _make_loader()
    err = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
        "GetConfigurationBundleVersion",
    )
    with patch.object(loader, "_fetch_config_from_bundle", side_effect=err):
        with pytest.raises(ClientError):
            loader.parse_configuration()
