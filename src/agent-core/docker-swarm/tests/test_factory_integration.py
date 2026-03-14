# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Integration test for swarm factory.

Run with AWS credentials configured:
    pytest tests/test_factory_integration.py -v -s

Note: This test requires:
- AWS credentials with Bedrock access
- Set AWS_REGION environment variable
"""
import logging
import os

import pytest

# Skip if no AWS credentials
pytestmark = pytest.mark.skipif(
    not os.environ.get("AWS_REGION"),
    reason="AWS_REGION not set - skipping integration tests",
)


class TestSwarmFactoryIntegration:
    """Integration tests that create actual Strands agents (but don't invoke them)."""

    @pytest.fixture
    def sample_config(self):
        from src.types import (
            InferenceConfig,
            ModelConfiguration,
            SwarmAgentDefinition,
            SwarmConfiguration,
        )

        return SwarmConfiguration(
            agents=[
                SwarmAgentDefinition(
                    name="researcher",
                    instructions="You are a research assistant. When you have enough information, hand off to the writer.",
                    modelInferenceParameters=ModelConfiguration(
                        modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                        parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
                    ),
                    tools=[],
                    toolParameters={},
                ),
                SwarmAgentDefinition(
                    name="writer",
                    instructions="You are a technical writer. Summarize the research findings clearly.",
                    modelInferenceParameters=ModelConfiguration(
                        modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                        parameters=InferenceConfig(maxTokens=4096, temperature=0.5),
                    ),
                    tools=[],
                    toolParameters={},
                ),
            ],
            entryAgent="researcher",
        )

    @pytest.fixture
    def logger(self):
        return logging.getLogger("test")

    def test_create_swarm_without_tools(self, sample_config, logger):
        """Test creating a swarm without any tools (no DynamoDB dependency)."""
        # Mock the registry to avoid DynamoDB calls
        import src.registry as registry

        registry.AVAILABLE_TOOLS = {}
        registry.AVAILABLE_MCPS = {}

        from src.factory import create_swarm

        swarm, callbacks, agents = create_swarm(
            configuration=sample_config,
            logger=logger,
            mcp_client_manager=None,
            session_manager=None,
        )

        assert swarm is not None
        assert len(agents) == 2
        assert "researcher" in agents
        assert "writer" in agents
        assert callbacks is not None

    def test_swarm_config_serialization(self, sample_config):
        """Test that config can be serialized to JSON (for DynamoDB storage)."""
        json_str = sample_config.model_dump_json()
        assert json_str is not None

        # Verify it can be deserialized
        from src.types import SwarmConfiguration

        restored = SwarmConfiguration.model_validate_json(json_str)
        assert restored.entryAgent == sample_config.entryAgent
        assert len(restored.agents) == len(sample_config.agents)
