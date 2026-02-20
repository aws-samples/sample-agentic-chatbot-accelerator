# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING
from urllib.parse import quote

import boto3
from aws_lambda_powertools import Logger, Tracer
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="mcp-seeder")
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
MCP_TABLE_NAME = os.environ["MCP_TABLE_NAME"]
AWS_REGION = os.environ["AWS_REGION"]
AWS_ACCOUNT_ID = os.environ["AWS_ACCOUNT_ID"]
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
MCP_TABLE = boto3.resource("dynamodb").Table(MCP_TABLE_NAME)  # type: ignore
BEDROCK_AGENTCORE = boto3.client("bedrock-agentcore-control", region_name=AWS_REGION)
# ---------------------------------------------------------- #


def compose_mcp_url(server: dict) -> str:
    """Compose the MCP URL for a server at runtime with resolved region/account.

    Args:
        server: Server config dict with name, description, and either runtimeId or gatewayId

    Returns:
        The composed MCP URL endpoint
    """
    qualifier = server.get("qualifier", "DEFAULT")

    if "runtimeId" in server and server["runtimeId"]:
        runtime_arn = f"arn:aws:bedrock-agentcore:{AWS_REGION}:{AWS_ACCOUNT_ID}:runtime/{server['runtimeId']}"
        encoded_arn = quote(runtime_arn, safe="")
        return f"https://bedrock-agentcore.{AWS_REGION}.amazonaws.com/runtimes/{encoded_arn}/invocations?qualifier={qualifier}"

    if "gatewayId" in server and server["gatewayId"]:
        return f"https://{server['gatewayId']}.gateway.bedrock-agentcore.{AWS_REGION}.amazonaws.com/mcp"

    raise ValueError(
        f"MCP server '{server['name']}' must have either runtimeId or gatewayId"
    )


def transform_server_for_db(server: dict) -> dict:
    """Transform server config to DynamoDB item with computed McpUrl.

    Handles both new format (name, runtimeId/gatewayId) and old format (McpServerName, McpUrl).

    Args:
        server: Server config from CDK (either old or new format)

    Returns:
        DynamoDB item with McpServerName, McpUrl, and Description
    """
    # Check if this is already in DB format (old format from rollback)
    if "McpServerName" in server:
        return {
            "McpServerName": server["McpServerName"],
            "McpUrl": server.get("McpUrl", ""),
            "Description": server.get("Description", ""),
        }

    # New format - need to compose URL
    return {
        "McpServerName": server["name"],
        "McpUrl": compose_mcp_url(server),
        "Description": server.get("description", ""),
    }


def get_server_name(server: dict) -> str:
    """Extract server name from either old or new format."""
    return server.get("McpServerName") or server.get("name", "")


@tracer.capture_lambda_handler
@logger.inject_lambda_context
def handler(event: dict, _: LambdaContext) -> dict:
    """CloudFormation Custom Resource handler for MCP Server Registry seeding.

    This handler is invoked by CloudFormation when the Custom Resource is created,
    updated, or deleted. It manages MCP server entries in DynamoDB with full
    lifecycle support (create, update, delete).

    Args:
        event (dict): CloudFormation Custom Resource event containing:
            - RequestType: 'Create', 'Update', or 'Delete'
            - ResourceProperties: Contains 'servers' (JSON string) and 'configHash'
            - OldResourceProperties: (Update only) Previous properties for diffing
        context (LambdaContext): Lambda execution context

    Returns:
        dict: Response containing PhysicalResourceId and Data
    """
    request_type = event["RequestType"]
    props = event["ResourceProperties"]

    # Parse raw server configs (name, description, runtimeId/gatewayId)
    raw_servers = json.loads(props.get("servers", "[]"))
    config_hash = props.get("configHash", "")

    # Transform to DB items with computed McpUrl
    servers = [transform_server_for_db(s) for s in raw_servers]

    # Build a map of server name -> server data for easy lookup
    new_servers_map = {s["McpServerName"]: s for s in servers}
    new_server_names = set(new_servers_map.keys())

    logger.info(
        "Processing Custom Resource request",
        extra={
            "requestType": request_type,
            "serverCount": len(servers),
            "configHash": config_hash,
        },
    )

    if request_type == "Create":
        # On Create, also clean up any stale servers from old seeders (migration)
        existing_server_names = _scan_all_server_names()
        stale_servers = existing_server_names - new_server_names

        if stale_servers:
            logger.info(
                "Found stale servers from previous seeder, removing",
                extra={"staleServers": list(stale_servers)},
            )
            _batch_delete_servers(list(stale_servers))

        # Insert all servers (pass raw configs for validation)
        _batch_put_servers(servers, raw_servers)
        physical_id = f"mcp-seeder-{config_hash[:16]}"

    elif request_type == "Update":
        # Get old servers from previous resource properties
        old_props = event.get("OldResourceProperties", {})
        old_raw_servers = json.loads(old_props.get("servers", "[]"))
        old_servers = [transform_server_for_db(s) for s in old_raw_servers]
        old_servers_map = {s["McpServerName"]: s for s in old_servers}
        old_server_names = set(old_servers_map.keys())

        # Calculate diff
        servers_to_add = new_server_names - old_server_names
        servers_to_remove = old_server_names - new_server_names
        servers_to_update = new_server_names & old_server_names

        logger.info(
            "Calculated diff",
            extra={
                "toAdd": list(servers_to_add),
                "toRemove": list(servers_to_remove),
                "toUpdate": list(servers_to_update),
            },
        )

        # Remove deleted servers
        if servers_to_remove:
            _batch_delete_servers(list(servers_to_remove))

        # Add new servers (need to find matching raw configs for validation)
        if servers_to_add:
            raw_servers_map = {get_server_name(s): s for s in raw_servers}
            servers_to_add_list = [new_servers_map[name] for name in servers_to_add]
            raw_servers_to_add = [raw_servers_map.get(name) for name in servers_to_add]
            _batch_put_servers(servers_to_add_list, raw_servers_to_add)

        # Update existing servers (check if content changed)
        raw_servers_map = {get_server_name(s): s for s in raw_servers}
        for name in servers_to_update:
            old_server = old_servers_map[name]
            new_server = new_servers_map[name]
            if old_server != new_server:
                raw_server = raw_servers_map.get(name)
                if _put_server(new_server, raw_server):
                    logger.info(f"Updated server: {name}")

        # Keep the same physical ID to maintain resource identity
        physical_id = event.get("PhysicalResourceId", f"mcp-seeder-{config_hash[:16]}")

    elif request_type == "Delete":
        # Remove all servers that were seeded
        if new_server_names:
            _batch_delete_servers(list(new_server_names))
        physical_id = event.get("PhysicalResourceId", "mcp-seeder-deleted")

    else:
        physical_id = event.get("PhysicalResourceId", "mcp-seeder-unknown")

    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "ServerCount": str(len(servers)),
            "ConfigHash": config_hash,
        },
    }


def _scan_all_server_names() -> set[str]:
    """Scan DynamoDB table and return all existing server names."""
    server_names: set[str] = set()
    paginator = MCP_TABLE.meta.client.get_paginator("scan")

    for page in paginator.paginate(
        TableName=MCP_TABLE_NAME,
        ProjectionExpression="McpServerName",
    ):
        for item in page.get("Items", []):
            if "McpServerName" in item:
                server_names.add(item["McpServerName"]["S"])

    logger.info(f"Found {len(server_names)} existing servers in table")
    return server_names


def _validate_runtime_endpoint_exists(
    runtime_id: str, qualifier: str = "DEFAULT"
) -> bool:
    """Validate that an agent runtime endpoint exists in the current region.

    Args:
        runtime_id: The agent runtime ID to validate
        qualifier: The endpoint name (qualifier), defaults to "DEFAULT"

    Returns:
        True if the runtime endpoint exists, False otherwise
    """
    try:
        BEDROCK_AGENTCORE.get_agent_runtime_endpoint(
            agentRuntimeId=runtime_id,
            endpointName=qualifier,
        )
        return True
    except ClientError as err:
        if err.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning(
                f"Agent runtime endpoint not found in region {AWS_REGION}",
                extra={"runtimeId": runtime_id, "endpoint": qualifier},
            )
            return False
        raise


def _validate_gateway_exists(gateway_id: str) -> bool:
    """Validate that a gateway exists in the current region.

    Args:
        gateway_id: The gateway ID to validate

    Returns:
        True if the gateway exists, False otherwise
    """
    try:
        BEDROCK_AGENTCORE.get_gateway(gatewayId=gateway_id)
        return True
    except ClientError as err:
        if err.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning(
                f"Gateway not found in region {AWS_REGION}",
                extra={"gatewayId": gateway_id},
            )
            return False
        raise


def _validate_server(raw_server: dict) -> bool:
    """Validate that the AgentCore resource (runtime endpoint or gateway) exists.

    Args:
        raw_server: Raw server config with runtimeId/gatewayId and optional qualifier

    Returns:
        True if the resource exists, False otherwise
    """
    qualifier = raw_server.get("qualifier", "DEFAULT")

    if "runtimeId" in raw_server and raw_server["runtimeId"]:
        return _validate_runtime_endpoint_exists(raw_server["runtimeId"], qualifier)

    if "gatewayId" in raw_server and raw_server["gatewayId"]:
        return _validate_gateway_exists(raw_server["gatewayId"])

    # Old format (McpServerName/McpUrl) - skip validation
    if "McpServerName" in raw_server:
        return True

    logger.warning(
        "Server config missing both runtimeId and gatewayId",
        extra={"server": raw_server},
    )
    return False


def _put_server(server: dict, raw_server: dict | None = None) -> bool:
    """Put a single MCP server entry into DynamoDB after validating resource exists.

    Args:
        server: Transformed server dict for DynamoDB (McpServerName, McpUrl, Description)
        raw_server: Optional raw server config for validation (runtimeId/gatewayId)

    Returns:
        True if server was successfully put, False if skipped due to validation failure
    """
    # Validate resource exists if raw config provided
    if raw_server and not _validate_server(raw_server):
        logger.warning(
            f"Skipping MCP server due to validation failure: {server['McpServerName']}"
        )
        return False

    try:
        MCP_TABLE.put_item(Item=server)
        logger.info(f"Successfully seeded MCP server: {server['McpServerName']}")
        return True
    except ClientError as err:
        logger.error(
            f"Failed to seed MCP server: {server['McpServerName']}",
            extra={"error": str(err)},
        )
        raise


def _batch_put_servers(
    servers: list[dict], raw_servers: list[dict | None] | None = None
) -> int:
    """Batch put MCP servers into DynamoDB after validating resources exist.

    Args:
        servers: List of transformed server dicts for DynamoDB
        raw_servers: Optional list of raw server configs for validation (same order as servers)

    Returns:
        Number of servers successfully seeded
    """
    if not servers:
        return 0

    # Build list of valid servers
    valid_servers: list[dict] = []
    for i, server in enumerate(servers):
        raw_server = raw_servers[i] if raw_servers and i < len(raw_servers) else None

        if raw_server and not _validate_server(raw_server):
            logger.warning(
                f"Skipping MCP server due to validation failure: {server['McpServerName']}"
            )
            continue

        valid_servers.append(server)

    if not valid_servers:
        logger.info("No valid servers to seed after validation")
        return 0

    with MCP_TABLE.batch_writer() as batch:
        for server in valid_servers:
            batch.put_item(Item=server)
            logger.info(f"Queued MCP server for seeding: {server['McpServerName']}")

    logger.info(f"Successfully seeded {len(valid_servers)} MCP servers")
    return len(valid_servers)


def _batch_delete_servers(server_names: list[str]) -> None:
    """Batch delete MCP servers from DynamoDB."""
    if not server_names:
        return

    with MCP_TABLE.batch_writer() as batch:
        for name in server_names:
            batch.delete_item(Key={"McpServerName": name})
            logger.info(f"Queued MCP server for deletion: {name}")

    logger.info(f"Successfully deleted {len(server_names)} MCP servers")
