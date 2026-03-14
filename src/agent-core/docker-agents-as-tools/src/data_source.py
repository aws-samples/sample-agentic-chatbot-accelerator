# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING

from shared.base_data_source import BaseConfigurationLoader
from shared.utils import deserialize

from .types import OrchestratorConfiguration

if TYPE_CHECKING:
    from logging import Logger


class OrchestratorConfigurationLoader(BaseConfigurationLoader):
    """Loader for orchestrator agent to be used in an `agents as tools` framework"""

    def parse_configuration(self) -> OrchestratorConfiguration:
        configuration_str = self._fetch_item_from_dynamodb(entity_type="orchestrator")

        parsed_cfg = deserialize(configuration_str, OrchestratorConfiguration)

        self._logger.info(
            "Successfully parsed the configuration",
            extra={"configurationValues": parsed_cfg.model_dump()},
        )
        return parsed_cfg  # type: ignore


def parse_configuration(logger: Logger) -> OrchestratorConfiguration:
    """Parse orchestrator configuration from DynamoDB.

    Args:
        logger (Logger): Logger instance for logging events

    Returns:
        OrchestratorConfiguration: Parsed orchestrator configuration

    Raises:
        ClientError: If DynamoDB read fails
        ValueError: If configuration not found or invalid
    """
    loader = OrchestratorConfigurationLoader(logger)
    return loader.parse_configuration()
