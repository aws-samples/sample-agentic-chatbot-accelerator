# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING

from shared.base_data_source import BaseConfigurationLoader
from shared.utils import deserialize

from .types import GraphConfiguration

if TYPE_CHECKING:
    from logging import Logger


class GraphConfigurationLoader(BaseConfigurationLoader):
    """Loads graph configurations from DynamoDB."""

    def __init__(self, logger: Logger):
        """Initialize the graph configuration loader.

        Args:
            logger (Logger): Logger instance for recording operations.
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

    def parse_configuration(self) -> GraphConfiguration:
        """Fetch and deserialize graph configuration from DynamoDB."""
        configuration_str = self._fetch_item_from_dynamodb(entity_type="graph")

        parsed_cfg: GraphConfiguration = deserialize(
            configuration_str, GraphConfiguration
        )  # type: ignore

        self._logger.info(
            "Successfully parsed the graph configuration",
            extra={
                "configurationValues": parsed_cfg.model_dump(),
                "nodeCount": len(parsed_cfg.nodes),
                "edgeCount": len(parsed_cfg.edges),
                "entryPoint": parsed_cfg.entryPoint,
            },
        )
        return parsed_cfg


def parse_configuration(logger: Logger) -> GraphConfiguration:
    """Parse graph configuration from DynamoDB."""
    loader = GraphConfigurationLoader(logger)
    return loader.parse_configuration()
