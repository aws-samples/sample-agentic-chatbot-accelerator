# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for swarm configuration types."""
import pytest
from pydantic import ValidationError
from src.types import (
    InferenceConfig,
    ModelConfiguration,
    SwarmAgentDefinition,
    SwarmConfiguration,
    SwarmOrchestratorConfig,
)


class TestSwarmAgentDefinition:
    def test_valid_agent_definition(self):
        agent = SwarmAgentDefinition(
            name="researcher",
            instructions="You are a research assistant.",
            modelInferenceParameters=ModelConfiguration(
                modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
            ),
            tools=["get_current_time"],
            toolParameters={"get_current_time": {}},
        )
        assert agent.name == "researcher"
        assert len(agent.tools) == 1

    def test_invalid_tool_parameters(self):
        """Tool parameters must match defined tools."""
        with pytest.raises(ValidationError) as exc_info:
            SwarmAgentDefinition(
                name="researcher",
                instructions="You are a research assistant.",
                modelInferenceParameters=ModelConfiguration(
                    modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                    parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
                ),
                tools=["get_current_time"],
                toolParameters={"unknown_tool": {}},  # Not in tools list
            )
        assert "toolParameters keys" in str(exc_info.value)

    def test_name_sanitization_spaces(self):
        """Agent names with spaces should be sanitized."""
        agent = SwarmAgentDefinition(
            name="research agent",
            instructions="You are a research assistant.",
            modelInferenceParameters=ModelConfiguration(
                modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
            ),
        )
        assert agent.name == "research_agent"
        assert " " not in agent.name

    def test_name_sanitization_special_chars(self):
        """Agent names with special characters should be sanitized."""
        agent = SwarmAgentDefinition(
            name="agent@test!",
            instructions="You are a test agent.",
            modelInferenceParameters=ModelConfiguration(
                modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
            ),
        )
        # Special chars replaced with underscores
        assert "@" not in agent.name
        assert "!" not in agent.name

    def test_name_sanitization_leading_special(self):
        """Agent names starting with special chars get prefixed."""
        agent = SwarmAgentDefinition(
            name="_test",
            instructions="You are a test agent.",
            modelInferenceParameters=ModelConfiguration(
                modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
            ),
        )
        # Should start with alphanumeric
        assert agent.name[0].isalnum()


class TestSwarmConfiguration:
    def get_sample_agent(self, name: str) -> SwarmAgentDefinition:
        return SwarmAgentDefinition(
            name=name,
            instructions=f"You are {name}.",
            modelInferenceParameters=ModelConfiguration(
                modelId="us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                parameters=InferenceConfig(maxTokens=4096, temperature=0.7),
            ),
        )

    def test_valid_swarm_configuration(self):
        config = SwarmConfiguration(
            agents=[
                self.get_sample_agent("researcher"),
                self.get_sample_agent("writer"),
            ],
            entryAgent="researcher",
        )
        assert len(config.agents) == 2
        assert config.entryAgent == "researcher"
        assert config.orchestrator.maxHandoffs == 20  # Default

    def test_invalid_entry_agent(self):
        """Entry agent must exist in agents list."""
        with pytest.raises(ValidationError) as exc_info:
            SwarmConfiguration(
                agents=[self.get_sample_agent("researcher")],
                entryAgent="nonexistent",
            )
        assert "entryAgent" in str(exc_info.value)

    def test_duplicate_agent_names(self):
        """Agent names must be unique."""
        with pytest.raises(ValidationError) as exc_info:
            SwarmConfiguration(
                agents=[
                    self.get_sample_agent("researcher"),
                    self.get_sample_agent("researcher"),  # Duplicate
                ],
                entryAgent="researcher",
            )
        assert "Duplicate agent names" in str(exc_info.value)

    def test_custom_orchestrator_config(self):
        config = SwarmConfiguration(
            agents=[self.get_sample_agent("researcher")],
            entryAgent="researcher",
            orchestrator=SwarmOrchestratorConfig(
                maxHandoffs=10,
                maxIterations=15,
                executionTimeoutSeconds=600.0,
                nodeTimeoutSeconds=120.0,
            ),
        )
        assert config.orchestrator.maxHandoffs == 10
        assert config.orchestrator.executionTimeoutSeconds == 600.0


class TestSwarmOrchestratorConfig:
    def test_defaults(self):
        config = SwarmOrchestratorConfig()
        assert config.maxHandoffs == 20
        assert config.maxIterations == 20
        assert config.executionTimeoutSeconds == 900.0
        assert config.nodeTimeoutSeconds == 300.0
        assert config.repetitiveHandoffDetectionWindow == 8
        assert config.repetitiveHandoffMinUniqueAgents == 3
