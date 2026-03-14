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
    """Base class for loading agent/swarm configurations from DynamoDB.

    This class provides common functionality for fetching configuration data
    from DynamoDB tables, including table initialization, error handling,
    and validation. Subclasses should override parse_configuration() to
    deserialize to their specific configuration type.

    Attributes:
        _logger (Logger): Logger instance for recording operations
        _table (Table): DynamoDB table resource for configuration storage
    """

    def __init__(self, logger: Logger, table_name_env_var: str = "tableName"):
        """Initialize the configuration loader.

        Args:
            logger (Logger): Logger instance for recording operations
            table_name_env_var (str): Environment variable containing the table name.
                Defaults to "tableName".
        """
        self._logger = logger
        self._table = self._get_table(table_name_env_var)

    def _get_table(self, table_name_env_var: str):
        """Get DynamoDB table resource.

        Args:
            table_name_env_var (str): Environment variable containing table name

        Returns:
            Table: DynamoDB table resource

        Raises:
            KeyError: If environment variable not found
        """
        table_name = os.environ[table_name_env_var]
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
        return dynamodb.Table(table_name)  # type: ignore

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

    def _fetch_item_from_dynamodb(
        self,
        agent_name: str | None = None,
        created_at: int | None = None,
        entity_type: str = "agent",
    ) -> str:
        """Fetch configuration string from DynamoDB.

        Args:
            agent_name (str | None): Agent name. If None, reads from 'agentName' env var.
            created_at (int | None): Creation timestamp. If None, reads from 'createdAt' env var.
            entity_type (str): Type of entity being loaded (for error messages). Defaults to "agent".

        Returns:
            str: The configuration string from ConfigurationValue field

        Raises:
            ClientError: If DynamoDB query fails
            ValueError: If item not found or has no configuration
        """
        if agent_name is None:
            agent_name = os.environ["agentName"]
        if created_at is None:
            created_at = int(os.environ["createdAt"])

        self._logger.info(
            f"Fetching {entity_type} configuration value from DynamoDb",
            extra={"compositeKey": {"AgentName": agent_name, "CreatedAt": created_at}},
        )

        try:
            response = self._table.get_item(
                Key={
                    "AgentName": agent_name,
                    "CreatedAt": created_at,
                }
            )
        except ClientError as err:
            self._logger.error(
                "Error reading from dynamoDB table", extra={"rawErrorMessage": str(err)}
            )
            raise

        if "Item" not in response:
            err_message = f"Did not find a match for {entity_type} {agent_name} created at {created_at}"
            self._logger.error(err_message)
            raise ValueError(err_message)

        item = response["Item"]
        configuration_str = item.get("ConfigurationValue")

        if configuration_str is None:
            err_message = (
                f"The item {agent_name} created at {created_at} has no configuration"
            )
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
