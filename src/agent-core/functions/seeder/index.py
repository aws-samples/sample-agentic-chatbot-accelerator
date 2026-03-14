# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import os
from typing import TYPE_CHECKING

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, parse
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="agentcore-seeder")
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
CFG_TABLE_NAME = os.environ["CFG_TABLE_NAME"]
DASHBOARD_TABLE_NAME = os.environ["DASHBOARD_TABLE_NAME"]
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
CFG_TABLE = boto3.resource("dynamodb").Table(CFG_TABLE_NAME)  # type: ignore
DASHBOARD_TABLE = boto3.resource("dynamodb").Table(DASHBOARD_TABLE_NAME)  # type: ignore
# ---------------------------------------------------------- #


class ItemValues(BaseModel):
    AgentName: str
    CreatedAt: int
    AgentRuntimeArn: str
    AgentRuntimeId: str
    AgentRuntimeVersion: str
    ConfigurationValue: str


class Properties(BaseModel):
    item: str
    configHash: str


@tracer.capture_lambda_handler
@logger.inject_lambda_context
def handler(event: dict, _: LambdaContext) -> dict:
    """CloudFormation Custom Resource handler for DynamoDB seeding.

    This handler is invoked by CloudFormation when the Custom Resource is created,
    updated, or deleted. It seeds the AgentCore runtime configuration table with
    the provided configuration.

    Args:
        event (dict): CloudFormation Custom Resource event containing:
            - RequestType: 'Create', 'Update', or 'Delete'
            - ResourceProperties: Contains 'Item' (JSON string) and 'ConfigHash'
        context (LambdaContext): Lambda execution context

    Returns:
        dict: Response containing PhysicalResourceId and Data
    """
    request_type = event["RequestType"]
    props = parse(event["ResourceProperties"], Properties)

    item = ItemValues.model_validate_json(props.item)
    physical_id = f"{item.AgentName}#{item.CreatedAt}"

    logger.info(
        "Processing Custom Resource request",
        extra={
            "requestType": request_type,
            "agentName": item.AgentName,
            "configHash": props.configHash,
        },
    )

    if request_type in ["Create", "Update"]:
        try:
            CFG_TABLE.put_item(Item=item.model_dump())
            logger.info(
                "Successfully seeded agent configuration",
                extra={"agentName": item.AgentName, "createdAt": item.CreatedAt},
            )
            _update_dashboard(
                item.AgentName,
                item.AgentRuntimeVersion,
                item.AgentRuntimeId,
                item.AgentRuntimeArn,
            )
        except ClientError as err:
            logger.error(
                "Failed to seed agent configuration",
                extra={"error": str(err), "item": item},
            )
            raise

    elif request_type == "Delete":
        # Optionally delete the item on stack deletion
        # For now, we keep the configuration for history/audit purposes
        logger.info(
            "Delete request received - keeping configuration for audit",
            extra={"agentName": item.AgentName},
        )

    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "AgentName": item.AgentName,
            "CreatedAt": str(item.CreatedAt),
        },
    }


def _update_dashboard(agent_name: str, version: str, runtime_id: str, runtime_arn: str):
    existing = DASHBOARD_TABLE.get_item(Key={"AgentName": agent_name})
    if "Item" in existing:
        DASHBOARD_TABLE.update_item(
            Key={"AgentName": agent_name},
            UpdateExpression="ADD NumberOfVersions :inc SET QualifierToVersion.#default = :ver",
            ExpressionAttributeNames={"#default": "DEFAULT"},
            ExpressionAttributeValues={":inc": 1, ":ver": version},
        )
    else:
        DASHBOARD_TABLE.put_item(
            Item={
                "AgentName": agent_name,
                "NumberOfVersions": 1,
                "QualifierToVersion": {"DEFAULT": version},
                "AgentRuntimeArn": runtime_arn,
                "AgentRuntimeId": runtime_id,
                "Status": "Ready",
            }
        )
