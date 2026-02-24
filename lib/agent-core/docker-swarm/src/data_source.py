# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from .types import (
    AgentReference,
    ModelConfiguration,
    SwarmAgentDefinition,
    SwarmConfiguration,
)
from .utils import deserialize

if TYPE_CHECKING:
    from logging import Logger

TABLE = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION")).Table(os.environ["tableName"])  # type: ignore

# Agent configuration table (for loading referenced agents)
_agents_table = None
_summary_table = None


def _get_agents_table():
    """Get the DynamoDB agents table with lazy initialization."""
    global _agents_table
    if _agents_table is None:
        table_name = os.environ.get("agentsTableName")
        if not table_name:
            raise ValueError(
                "agentsTableName environment variable is required for loading agent references"
            )
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
        _agents_table = dynamodb.Table(table_name)
    return _agents_table


def _get_summary_table():
    """Get the DynamoDB summary table"""
    global _summary_table
    if _summary_table is None:
        table_name = os.environ.get("agentsSummaryTableName")
        if not table_name:
            raise ValueError(
                "agentsSummaryTableName environment variable is required for resolving agent endpoints"
            )
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
        _summary_table = dynamodb.Table(table_name)
    return _summary_table


def _load_agent_config(ref: AgentReference, logger: Logger) -> SwarmAgentDefinition:
    """Load an agent configuration from DynamoDB by endpoint name.

    Resolves the endpoint name to a version via the summary table's
    QualifierToVersion mapping, then fetches the config for that version.

    Args:
        ref (AgentReference): Reference containing agentName and endpointName
        logger (Logger): Logger instance

    Returns:
        SwarmAgentDefinition: The agent definition for use in the swarm

    Raises:
        ValueError: If agent/endpoint not found or has no configuration
        ClientError: If DynamoDB query fails
    """
    summary_table = _get_summary_table()
    agents_table = _get_agents_table()

    try:
        response = summary_table.query(
            KeyConditionExpression="AgentName = :agent",
            ExpressionAttributeValues={":agent": ref.agentName},
        )
    except ClientError as err:
        logger.error(
            f"Error querying summary table for agent '{ref.agentName}'",
            extra={"rawErrorMessage": str(err)},
        )
        raise

    items = response.get("Items", [])
    if not items:
        raise ValueError(f"Agent '{ref.agentName}' not found in summary table")

    qualifier_to_version = items[0].get("QualifierToVersion", {})
    if ref.endpointName not in qualifier_to_version:
        raise ValueError(
            f"Agent '{ref.agentName}' has no endpoint '{ref.endpointName}'. "
            f"Available endpoints: {list(qualifier_to_version.keys())}"
        )

    version = str(qualifier_to_version[ref.endpointName])

    logger.info(
        f"Loading config for agent '{ref.agentName}' "
        f"endpoint '{ref.endpointName}' (version {version})",
    )

    try:
        response = agents_table.query(
            IndexName="byAgentNameAndVersion",
            KeyConditionExpression=Key("AgentName").eq(ref.agentName)
            & Key("AgentRuntimeVersion").eq(version),
        )
    except ClientError as err:
        logger.error(
            f"Error querying agent '{ref.agentName}' from DynamoDB",
            extra={"rawErrorMessage": str(err)},
        )
        raise

    items = response.get("Items", [])
    if not items:
        raise ValueError(
            f"Agent '{ref.agentName}' endpoint '{ref.endpointName}' "
            f"(version {version}) not found in agents table"
        )

    config_str = items[0].get("ConfigurationValue")
    if config_str is None:
        raise ValueError(f"Agent '{ref.agentName}' has no configuration")

    config_data = json.loads(config_str)

    agent_def = SwarmAgentDefinition(
        name=ref.agentName,
        instructions=config_data.get("instructions", ""),
        modelInferenceParameters=ModelConfiguration.model_validate(
            config_data.get("modelInferenceParameters", {})
        ),
        tools=config_data.get("tools", []),
        toolParameters=config_data.get("toolParameters", {}),
        mcpServers=config_data.get("mcpServers", []),
    )

    logger.info(
        f"Successfully loaded agent '{ref.agentName}'",
        extra={"toolCount": len(agent_def.tools)},
    )

    return agent_def


def parse_configuration(logger: Logger) -> SwarmConfiguration:
    """Parse swarm configuration from DynamoDB.

    If the configuration uses agentReferences, this function will load
    each referenced agent's configuration and populate the agents list.

    Args:
        logger (Logger): Logger instance for logging events

    Returns:
        SwarmConfiguration: Parsed swarm configuration with agents populated

    Raises:
        ClientError: If DynamoDB read fails
        ValueError: If configuration not found or invalid
    """
    agent_name = os.environ["agentName"]
    created_at = int(os.environ["createdAt"])
    logger.info(
        "Fetching swarm configuration value from DynamoDb",
        extra={"compositeKey": {"AgentName": agent_name, "CreatedAt": created_at}},
    )
    try:
        response = TABLE.get_item(
            Key={
                "AgentName": agent_name,
                "CreatedAt": created_at,
            }
        )
    except ClientError as err:
        logger.error(
            "Error reading from dynamoDB table", extra={"rawErrorMessage": str(err)}
        )
        raise

    if "Item" not in response:
        err_message = (
            f"Did not find a match for swarm {agent_name} created at {created_at}"
        )
        logger.error(err_message)
        raise ValueError(err_message)

    configuration_str = response["Item"].get("ConfigurationValue")
    if configuration_str is None:
        err_message = (
            f"The item {agent_name} created at {created_at} has no configuration"
        )
        raise ValueError(err_message)

    parsed_cfg = deserialize(configuration_str, SwarmConfiguration)

    if parsed_cfg.agentReferences and not parsed_cfg.agents:
        logger.info(
            f"Loading {len(parsed_cfg.agentReferences)} referenced agents",
            extra={"references": [r.agentName for r in parsed_cfg.agentReferences]},
        )

        loaded_agents: list[SwarmAgentDefinition] = []
        for ref in parsed_cfg.agentReferences:
            agent_def = _load_agent_config(ref, logger)
            loaded_agents.append(agent_def)

        parsed_cfg = SwarmConfiguration(
            agents=loaded_agents,
            agentReferences=[],
            entryAgent=parsed_cfg.entryAgent,
            orchestrator=parsed_cfg.orchestrator,
            conversationManager=parsed_cfg.conversationManager,
        )

    logger.info(
        "Successfully parsed the swarm configuration",
        extra={
            "configurationValues": parsed_cfg.model_dump(),
            "agentCount": len(parsed_cfg.agents),
            "entryAgent": parsed_cfg.entryAgent,
        },
    )
    return parsed_cfg  # type: ignore
