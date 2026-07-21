# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING

from shared.base_data_source import BaseConfigurationLoader
from shared.utils import deserialize

from .types import AgentConfiguration

if TYPE_CHECKING:
    from logging import Logger


class AgentConfigurationLoader(BaseConfigurationLoader):
    """Loader for agent configurations from a configuration bundle."""

    def parse_configuration(self) -> AgentConfiguration:
        """Parse the agent configuration sourced from the config bundle.

        Fetches ConfigurationValue via _fetch_config_from_bundle (control plane)
        and deserializes to AgentConfiguration.

        Returns:
            AgentConfiguration: Parsed agent configuration

        Raises:
            ClientError: If the control-plane fetch fails
            ValueError: If configuration not found or invalid
        """
        configuration_str = self._fetch_config_from_bundle(entity_type="agent")

        parsed_cfg = deserialize(configuration_str, AgentConfiguration)

        self._logger.info(
            "Successfully parsed the configuration",
            extra={"configurationValues": parsed_cfg.model_dump()},
        )
        return parsed_cfg  # type: ignore


def parse_configuration(logger: Logger) -> AgentConfiguration:
    """Parse agent configuration from the config bundle.

    Args:
        logger (Logger): Logger instance for logging events

    Returns:
        AgentConfiguration: Parsed agent configuration

    Raises:
        ClientError: If the control-plane fetch fails
        ValueError: If configuration not found or invalid
    """
    loader = AgentConfigurationLoader(logger)
    return loader.parse_configuration()
