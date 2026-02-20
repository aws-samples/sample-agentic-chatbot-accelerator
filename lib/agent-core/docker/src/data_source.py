# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import os
from typing import TYPE_CHECKING

import boto3
from botocore.exceptions import ClientError

from .types import AgentConfiguration
from .utils import deserialize

if TYPE_CHECKING:
    from logging import Logger

TABLE = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION")).Table(os.environ["tableName"])  # type: ignore


def parse_configuration(logger: Logger) -> AgentConfiguration:
    agent_name = os.environ["agentName"]
    created_at = int(os.environ["createdAt"])
    logger.info(
        "Fetching configuration value from DynamoDb",
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
            f"Did not find a match for agent {agent_name} created at {created_at}"
        )
        logger.error(err_message)
        raise ValueError(err_message)

    configuration_str = response["Item"].get("ConfigurationValue")
    if configuration_str is None:
        err_message = (
            f"The item {agent_name} created at {created_at} has no configuration"
        )
        raise ValueError(err_message)

    parsed_cfg = deserialize(configuration_str, AgentConfiguration)

    logger.info(
        "Successfully parsed the configuration",
        extra={"configurationValues": parsed_cfg.model_dump()},
    )
    return parsed_cfg  # type: ignore
