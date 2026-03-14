# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from shared.base_data_source import BaseConfigurationLoader
from shared.utils import deserialize

from .types import (
    AgentReference,
    ModelConfiguration,
    SwarmAgentDefinition,
    SwarmConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger


class SwarmConfigurationLoader(BaseConfigurationLoader):
    """Loader for swarm configurations from DynamoDB.

    This loader supports loading swarm configurations that may reference
    other agents via agentReferences. It will automatically resolve and
    load referenced agent configurations.
    """

    def __init__(self, logger: Logger):
        """Initialize the swarm configuration loader.

        Args:
            logger (Logger): Logger instance for recording operations
        """
        super().__init__(logger)
        self._agents_table = None
        self._summary_table = None

    def _get_agents_table(self):
        """Get the DynamoDB agents table with lazy initialization."""
        return self._get_lazy_table("agentsTableName", "_agents_table")

    def _get_summary_table(self):
        """Get the DynamoDB summary table with lazy initialization."""
        return self._get_lazy_table("agentsSummaryTableName", "_summary_table")

    def _load_agent_config(self, ref: AgentReference) -> SwarmAgentDefinition:
        """Load an agent configuration from DynamoDB by endpoint name.

        Resolves the endpoint name to a version via the summary table's
        QualifierToVersion mapping, then fetches the config for that version.

        Args:
            ref (AgentReference): Reference containing agentName and endpointName

        Returns:
            SwarmAgentDefinition: The agent definition for use in the swarm

        Raises:
            ValueError: If agent/endpoint not found or has no configuration
            ClientError: If DynamoDB query fails
        """
        summary_table = self._get_summary_table()
        agents_table = self._get_agents_table()

        try:
            response = summary_table.query(
                KeyConditionExpression="AgentName = :agent",
                ExpressionAttributeValues={":agent": ref.agentName},
            )
        except ClientError as err:
            self._logger.error(
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

        self._logger.info(
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
            self._logger.error(
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

        self._logger.info(
            f"Successfully loaded agent '{ref.agentName}'",
            extra={"toolCount": len(agent_def.tools)},
        )

        return agent_def

    def parse_configuration(self) -> SwarmConfiguration:
        """Parse swarm configuration from DynamoDB.

        If the configuration uses agentReferences, this method will load
        each referenced agent's configuration and populate the agents list.

        Returns:
            SwarmConfiguration: Parsed swarm configuration with agents populated

        Raises:
            ClientError: If DynamoDB read fails
            ValueError: If configuration not found or invalid
        """
        configuration_str = self._fetch_item_from_dynamodb(entity_type="swarm")

        parsed_cfg: SwarmConfiguration = deserialize(
            configuration_str, SwarmConfiguration
        )  # type: ignore

        if parsed_cfg.agentReferences and not parsed_cfg.agents:
            self._logger.info(
                f"Loading {len(parsed_cfg.agentReferences)} referenced agents",
                extra={"references": [r.agentName for r in parsed_cfg.agentReferences]},
            )

            loaded_agents: list[SwarmAgentDefinition] = []
            for ref in parsed_cfg.agentReferences:
                agent_def = self._load_agent_config(ref)
                loaded_agents.append(agent_def)

            parsed_cfg = SwarmConfiguration(
                agents=loaded_agents,
                agentReferences=[],
                entryAgent=parsed_cfg.entryAgent,
                orchestrator=parsed_cfg.orchestrator,
                conversationManager=parsed_cfg.conversationManager,
            )

        self._logger.info(
            "Successfully parsed the swarm configuration",
            extra={
                "configurationValues": parsed_cfg.model_dump(),
                "agentCount": len(parsed_cfg.agents),
                "entryAgent": parsed_cfg.entryAgent,
            },
        )
        return parsed_cfg  # type: ignore


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
    loader = SwarmConfigurationLoader(logger)
    return loader.parse_configuration()
