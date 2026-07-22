# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Shared fixtures for graph tests."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.types import (
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
    GraphOrchestratorConfig,
)


@pytest.fixture
def sample_node_research() -> GraphNodeDefinition:
    return GraphNodeDefinition(
        id="node_research",
        agentName="research_agent",
        endpointName="DEFAULT",
        label="Research",
    )


@pytest.fixture
def sample_node_writer() -> GraphNodeDefinition:
    return GraphNodeDefinition(
        id="node_writer",
        agentName="writer_agent",
        endpointName="DEFAULT",
        label="Writer",
    )


@pytest.fixture
def sample_node_reviewer() -> GraphNodeDefinition:
    return GraphNodeDefinition(
        id="node_reviewer",
        agentName="reviewer_agent",
        endpointName="DEFAULT",
        label="Reviewer",
    )


@pytest.fixture
def sample_edge_research_to_writer() -> GraphEdgeDefinition:
    return GraphEdgeDefinition(
        source="node_research",
        target="node_writer",
    )


@pytest.fixture
def sample_edge_writer_to_reviewer() -> GraphEdgeDefinition:
    return GraphEdgeDefinition(
        source="node_writer",
        target="node_reviewer",
    )


@pytest.fixture
def sample_edge_reviewer_to_end() -> GraphEdgeDefinition:
    return GraphEdgeDefinition(
        source="node_reviewer",
        target="__end__",
        condition="state.get('is_complete', False)",
    )


@pytest.fixture
def sample_edge_reviewer_to_writer() -> GraphEdgeDefinition:
    return GraphEdgeDefinition(
        source="node_reviewer",
        target="node_writer",
        condition="not state.get('is_complete', False)",
    )


@pytest.fixture
def minimal_graph_configuration() -> GraphConfiguration:
    """Minimal valid config: solo_node --> __end__"""
    return GraphConfiguration(
        nodes=[
            GraphNodeDefinition(
                id="solo_node",
                agentName="solo_agent",
                endpointName="DEFAULT",
            )
        ],
        edges=[
            GraphEdgeDefinition(source="solo_node", target="__end__"),
        ],
        entryPoint="solo_node",
    )


@pytest.fixture
def sample_graph_configuration(
    sample_node_research,
    sample_node_writer,
    sample_node_reviewer,
    sample_edge_research_to_writer,
    sample_edge_writer_to_reviewer,
    sample_edge_reviewer_to_end,
    sample_edge_reviewer_to_writer,
) -> GraphConfiguration:
    """3-node graph: research -> writer -> reviewer with revision loop."""
    return GraphConfiguration(
        nodes=[sample_node_research, sample_node_writer, sample_node_reviewer],
        edges=[
            sample_edge_research_to_writer,
            sample_edge_writer_to_reviewer,
            sample_edge_reviewer_to_end,
            sample_edge_reviewer_to_writer,
        ],
        entryPoint="node_research",
        stateSchema={
            "messages": "list",
            "research_results": "str",
            "is_complete": "bool",
        },
        orchestrator=GraphOrchestratorConfig(
            maxIterations=50,
            executionTimeoutSeconds=300.0,
            nodeTimeoutSeconds=60.0,
        ),
    )


# NOTE: the former `mock_dynamodb_table` fixture (which patched a `tableName`
# env var and mocked the DynamoDB config read) was removed with the
# configuration-bundles migration — the container config read path is now the
# control-plane bundle fetch, exercised via patch.object on
# `_fetch_config_from_bundle` in test_data_source.py.


@pytest.fixture
def mock_agentcore_client():
    """Mock the A2A sub-agent invocation pipeline.

    Patches both the runtime-arn resolver (which would otherwise hit the
    summary DynamoDB table) and the A2A invocation function (which would
    otherwise issue a SigV4-signed httpx call). Yields the mock invoker so
    tests can assert call counts / inspect arguments.
    """
    from shared.a2a_client import A2AInvocationResult

    fake_arns = {
        "research_agent": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/research_agent_a2a-X",
        "writer_agent": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/writer_agent_a2a-X",
        "reviewer_agent": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/reviewer_agent_a2a-X",
        "solo_agent": "arn:aws:bedrock-agentcore:us-east-1:1:runtime/solo_agent_a2a-X",
    }

    invoke_mock = MagicMock(
        return_value=A2AInvocationResult(content="Mock agent response")
    )

    with patch(
        "src.factory._fetch_a2a_runtime_arn",
        side_effect=lambda name: fake_arns.get(name, f"arn:fake:{name}"),
    ), patch("src.factory.invoke_a2a_subagent", invoke_mock), patch.dict(
        "os.environ",
        {
            "accountId": "123456789012",
            "AWS_REGION": "us-east-1",
            "agentsSummaryTableName": "test-agents-summary",
        },
    ):
        import src.factory as factory_module

        factory_module._agent_a2a_arn_cache.clear()
        yield {
            "invoke_a2a": invoke_mock,
        }
