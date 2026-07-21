# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
from typing import TYPE_CHECKING

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
        self._summary_table = None

    def _get_summary_table(self):
        """Get the DynamoDB summary table with lazy initialization."""
        return self._get_lazy_table("agentsSummaryTableName", "_summary_table")

    def _load_agent_config(self, ref: AgentReference) -> SwarmAgentDefinition:
        """Load a referenced sub-agent's configuration from its bundle.

        Resolves the endpoint name to a bundle versionId via the summary table's
        QualifierToVersion mapping, then fetches that sub-agent's config from its
        own configuration bundle via the control plane (ADR-0001). The component
        is keyed by the sub-agent's stable agent id (ADR-0002).

        Args:
            ref (AgentReference): Reference containing agentName and endpointName

        Returns:
            SwarmAgentDefinition: The agent definition for use in the swarm

        Raises:
            ValueError: If agent/endpoint/bundle not found or has no configuration
            ClientError: If DynamoDB query or the control-plane fetch fails
        """
        summary_table = self._get_summary_table()

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

        row = items[0]
        qualifier_to_version = row.get("QualifierToVersion", {})
        if ref.endpointName not in qualifier_to_version:
            raise ValueError(
                f"Agent '{ref.agentName}' has no endpoint '{ref.endpointName}'. "
                f"Available endpoints: {list(qualifier_to_version.keys())}"
            )

        # QualifierToVersion now stores the bundle versionId for each endpoint.
        version_id = str(qualifier_to_version[ref.endpointName])
        bundle_id = row.get("BundleId")
        if not bundle_id:
            raise ValueError(
                f"Agent '{ref.agentName}' has no BundleId in the summary table"
            )

        self._logger.info(
            f"Loading config for agent '{ref.agentName}' "
            f"endpoint '{ref.endpointName}' (bundle {bundle_id} version {version_id})",
        )

        # Fetch the sub-agent's ConfigurationValue from its own bundle; the
        # component is keyed by the sub-agent's stable agent id (ADR-0002).
        config_str = self._fetch_config_from_bundle(
            bundle_id=bundle_id,
            bundle_version=version_id,
            component_key=ref.agentName,
            entity_type="sub-agent",
        )

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
        """Parse swarm configuration sourced from the config bundle.

        Fetches the top-level swarm ConfigurationValue via _fetch_config_from_bundle
        (control plane). If the configuration uses agentReferences, this method
        still resolves each referenced agent via the summary/agents tables and
        populates the agents list (unchanged).

        Returns:
            SwarmConfiguration: Parsed swarm configuration with agents populated

        Raises:
            ClientError: If the control-plane fetch or DynamoDB read fails
            ValueError: If configuration not found or invalid
        """
        configuration_str = self._fetch_config_from_bundle(entity_type="swarm")

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
    """Parse swarm configuration from the config bundle.

    If the configuration uses agentReferences, this function will load
    each referenced agent's configuration and populate the agents list.

    Args:
        logger (Logger): Logger instance for logging events

    Returns:
        SwarmConfiguration: Parsed swarm configuration with agents populated

    Raises:
        ClientError: If the control-plane fetch or DynamoDB read fails
        ValueError: If configuration not found or invalid
    """
    loader = SwarmConfigurationLoader(logger)
    return loader.parse_configuration()
