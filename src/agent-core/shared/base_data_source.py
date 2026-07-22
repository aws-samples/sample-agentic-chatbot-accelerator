# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared base classes for loading agent/swarm configurations from DynamoDB.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, TypeVar

import boto3
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from logging import Logger

T = TypeVar("T")


class BaseConfigurationLoader:
    """Base class for loading agent/swarm configurations.

    Provides the control-plane bundle-fetch path (``_fetch_config_from_bundle``)
    shared by all container loaders (ADR-0001), plus a lazy DynamoDB table
    helper (``_get_lazy_table``) for subclasses that still need an auxiliary
    table (e.g. the swarm summary table). Subclasses override
    parse_configuration() to deserialize to their specific configuration type.

    Attributes:
        _logger (Logger): Logger instance for recording operations
    """

    def __init__(self, logger: Logger):
        """Initialize the configuration loader.

        Agent config is now read from AgentCore configuration bundles via the
        control plane (see ADR-0001), so the loader no longer eagerly binds a
        DynamoDB config table at construction. Subclasses that still need a
        DynamoDB table for auxiliary lookups (e.g. the swarm summary table) do
        so lazily via ``_get_lazy_table``.

        Args:
            logger (Logger): Logger instance for recording operations
        """
        self._logger = logger

    def _get_lazy_table(self, table_name_env_var: str, cache_attr: str):
        """Get DynamoDB table with lazy initialization and caching.

        Args:
            table_name_env_var (str): Environment variable containing table name
            cache_attr (str): Attribute name for caching the table instance

        Returns:
            Table: DynamoDB table resource

        Raises:
            ValueError: If environment variable not found
        """
        if not hasattr(self, cache_attr) or getattr(self, cache_attr) is None:
            table_name = os.environ.get(table_name_env_var)
            if not table_name:
                raise ValueError(
                    f"{table_name_env_var} environment variable is required"
                )
            dynamodb = boto3.resource(
                "dynamodb", region_name=os.environ.get("AWS_REGION")
            )
            setattr(self, cache_attr, dynamodb.Table(table_name))  # type: ignore
        return getattr(self, cache_attr)

    def _fetch_config_from_bundle(
        self,
        bundle_id: str | None = None,
        bundle_version: str | None = None,
        component_key: str | None = None,
        entity_type: str = "agent",
    ) -> str:
        """Fetch the ConfigurationValue JSON string from a configuration bundle version.

        Reads via the control plane (no Gateway/baggage — see ADR-0001):
        `bedrock-agentcore-control.get_configuration_bundle_version(bundleId, versionId)`,
        then returns `components[component_key]["configuration"]["ConfigurationValue"]`.

        Args:
            bundle_id (str | None): Bundle id. If None, reads the `BUNDLE_ID` env var.
            bundle_version (str | None): Immutable version id. If None, reads the
                `BUNDLE_VERSION` env var.
            component_key (str | None): Stable component key (agent id). If None, reads
                the `agentName` env var (ADR-0002).
            entity_type (str): Type of entity being loaded (for error messages).
                Defaults to "agent".

        Returns:
            str: The ConfigurationValue JSON string (same shape as the old DynamoDB field).

        Raises:
            ClientError: If the control-plane call fails.
            ValueError: If the component/key is missing or has no ConfigurationValue.
        """
        if bundle_id is None:
            bundle_id = os.environ["BUNDLE_ID"]
        if bundle_version is None:
            bundle_version = os.environ["BUNDLE_VERSION"]
        if component_key is None:
            component_key = os.environ["agentName"]

        self._logger.info(
            f"Fetching {entity_type} configuration value from configuration bundle",
            extra={
                "bundleId": bundle_id,
                "bundleVersion": bundle_version,
                "componentKey": component_key,
            },
        )

        client = boto3.client(
            "bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION")
        )

        try:
            response = client.get_configuration_bundle_version(
                bundleId=bundle_id,
                versionId=bundle_version,
            )
        except ClientError as err:
            self._logger.error(
                "Error reading configuration bundle version",
                extra={"rawErrorMessage": str(err)},
            )
            raise

        components = response.get("components") or {}
        component = components.get(component_key)
        if component is None:
            err_message = (
                f"Configuration bundle {bundle_id} version {bundle_version} has no "
                f"component for {entity_type} {component_key}"
            )
            self._logger.error(err_message)
            raise ValueError(err_message)

        configuration_str = component.get("configuration", {}).get("ConfigurationValue")
        if configuration_str is None:
            err_message = (
                f"Component {component_key} in bundle {bundle_id} version "
                f"{bundle_version} has no ConfigurationValue"
            )
            self._logger.error(err_message)
            raise ValueError(err_message)

        return configuration_str

    def parse_configuration(self) -> Any:
        """Parse and return the configuration object.

        This method should be overridden by subclasses to deserialize
        the configuration string to their specific configuration type.

        Returns:
            Any: The parsed configuration object

        Raises:
            NotImplementedError: If not overridden by subclass
        """
        raise NotImplementedError(
            "Subclasses must implement parse_configuration() method"
        )
