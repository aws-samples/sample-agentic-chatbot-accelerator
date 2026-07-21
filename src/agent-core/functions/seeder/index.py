# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import os
import re
import uuid
from typing import TYPE_CHECKING, Optional

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
DASHBOARD_TABLE_NAME = os.environ["DASHBOARD_TABLE_NAME"]
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
DASHBOARD_TABLE = boto3.resource("dynamodb").Table(DASHBOARD_TABLE_NAME)  # type: ignore
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# Bundle names must match ^[a-zA-Z][a-zA-Z0-9_]{0,99}$ before AWS appends its
# random suffix — so the sanitized prefix is capped at 100 chars.
BUNDLE_NAME_MAX = 100


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
            existing = DASHBOARD_TABLE.get_item(Key={"AgentName": item.AgentName}).get(
                "Item"
            )

            # Idempotency: CloudFormation only re-invokes the seeder when the
            # CustomResource properties change (createdAt is derived from the
            # config hash), so an unchanged config normally never reaches here.
            # Guard anyway — if the stored ConfigHash matches, skip creating a
            # redundant bundle version.
            if existing and existing.get("ConfigHash") == props.configHash:
                logger.info(
                    "Config hash unchanged - skipping bundle version",
                    extra={
                        "agentName": item.AgentName,
                        "configHash": props.configHash,
                    },
                )
                return _response(physical_id, item)

            # Version an existing bundle, or create a new one (ADR-0002).
            bundle_id = existing.get("BundleId") if existing else None
            parent_version_id = (
                existing.get("QualifierToVersion", {}).get("DEFAULT")
                if existing
                else None
            )
            new_bundle_id, bundle_arn, version_id = _put_config_bundle(
                item.AgentName,
                item.ConfigurationValue,
                bundle_id,
                parent_version_id,
            )
            logger.info(
                "Successfully seeded agent configuration bundle",
                extra={
                    "agentName": item.AgentName,
                    "bundleId": new_bundle_id,
                    "versionId": version_id,
                },
            )
            _update_dashboard(
                item.AgentName,
                version_id,
                item.AgentRuntimeId,
                item.AgentRuntimeArn,
                new_bundle_id,
                bundle_arn,
                props.configHash,
                existing is not None,
            )
        except ClientError as err:
            logger.error(
                "Failed to seed agent configuration",
                extra={"error": str(err), "agentName": item.AgentName},
            )
            raise

    elif request_type == "Delete":
        # Optionally delete the item on stack deletion
        # For now, we keep the configuration for history/audit purposes
        logger.info(
            "Delete request received - keeping configuration for audit",
            extra={"agentName": item.AgentName},
        )

    return _response(physical_id, item)


def _response(physical_id: str, item: ItemValues) -> dict:
    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "AgentName": item.AgentName,
            "CreatedAt": str(item.CreatedAt),
        },
    }


def sanitize_bundle_name(agent_name: str) -> str:
    """Map an agent name to a valid bundle-name prefix: ``[a-zA-Z][a-zA-Z0-9_]{0,99}``.

    Mirrors ``put-config-bundle`` (T4) — see ``src/api/functions/put-config-bundle``.
    Kept as a local copy because the seeder and that Lambda are separate
    deployment packages with no shared import path.
    """
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", agent_name)
    if not sanitized or not sanitized[0].isalpha():
        sanitized = f"a_{sanitized}"
    return sanitized[:BUNDLE_NAME_MAX]


def _put_config_bundle(
    agent_name: str,
    configuration_value: str,
    bundle_id: Optional[str],
    parent_version_id: Optional[str],
) -> tuple[str, str, str]:
    """Create-or-version the default agent's configuration bundle.

    Mirrors the ``put-config-bundle`` Lambda (T4): create when ``bundle_id`` is
    None, else update with ``parentVersionIds=[parent_version_id]``. Returns
    ``(bundleId, bundleArn, versionId)``.
    """
    components = {
        agent_name: {"configuration": {"ConfigurationValue": configuration_value}}
    }
    api_args = {
        "components": components,
        "clientToken": str(uuid.uuid4()),  # idempotency for at-least-once retries
        "commitMessage": "Seeded by CDK deploy",
    }
    if bundle_id:
        api_args["bundleId"] = bundle_id
        if parent_version_id:
            api_args["parentVersionIds"] = [parent_version_id]
        response = BAC_CLIENT.update_configuration_bundle(**api_args)
    else:
        api_args["bundleName"] = sanitize_bundle_name(agent_name)
        response = BAC_CLIENT.create_configuration_bundle(**api_args)

    return response["bundleId"], response["bundleArn"], response["versionId"]


def _update_dashboard(
    agent_name: str,
    version_id: str,
    runtime_id: str,
    runtime_arn: str,
    bundle_id: str,
    bundle_arn: str,
    config_hash: str,
    exists: bool,
):
    """Write the summary row with bundle identity. No runtime-config-table write."""
    if exists:
        DASHBOARD_TABLE.update_item(
            Key={"AgentName": agent_name},
            UpdateExpression=(
                "ADD NumberOfVersions :inc "
                "SET QualifierToVersion.#default = :ver, "
                "BundleId = :bid, BundleArn = :barn, ConfigHash = :hash"
            ),
            ExpressionAttributeNames={"#default": "DEFAULT"},
            ExpressionAttributeValues={
                ":inc": 1,
                ":ver": version_id,
                ":bid": bundle_id,
                ":barn": bundle_arn,
                ":hash": config_hash,
            },
        )
    else:
        DASHBOARD_TABLE.put_item(
            Item={
                "AgentName": agent_name,
                "NumberOfVersions": 1,
                "QualifierToVersion": {"DEFAULT": version_id},
                "AgentRuntimeArn": runtime_arn,
                "AgentRuntimeId": runtime_id,
                "BundleId": bundle_id,
                "BundleArn": bundle_arn,
                "ConfigHash": config_hash,
                "Status": "Ready",
            }
        )
