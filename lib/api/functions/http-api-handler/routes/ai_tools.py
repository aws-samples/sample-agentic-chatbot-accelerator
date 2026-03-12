# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
import re
from typing import Mapping, Sequence
from urllib.parse import quote

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from botocore.exceptions import ClientError
from genai_core.api_helper.auth import fetch_user_id

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-strandsCfgRoute")
# -------------------------------------------------------------------- #
TOOL_TABLE = boto3.resource("dynamodb").Table(os.environ["TOOL_REGISTRY_TABLE"])  # type: ignore
MCP_SERVER_TABLE = boto3.resource("dynamodb").Table(os.environ["MCP_SERVER_REGISTRY_TABLE"])  # type: ignore
BEDROCK_AGENTCORE = boto3.client(
    "bedrock-agentcore-control", region_name=os.environ["REGION_NAME"]
)

# ----------------------- Environment Variables ---------------------- #
REGION_NAME = os.environ["REGION_NAME"]
AWS_ACCOUNT_ID = os.environ["AWS_ACCOUNT_ID"]
# -------------------------------------------------------------------- #

# Valid MCP server name pattern: alphanumeric, hyphens, underscores
MCP_SERVER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
VALID_AUTH_TYPES = {"SIGV4", "NONE"}


# ---- Queries ---- #
@router.resolver(field_name="listAvailableTools")
@tracer.capture_method
@fetch_user_id(router)
def list_tools(user_id: str) -> Sequence[Mapping]:
    logger.info(f"User ID {user_id} is querying available tools")

    response = TOOL_TABLE.scan(Limit=100)  # assuming no more than 100 tools

    return [
        {
            "name": elem.get("ToolName", ""),
            "description": elem.get("ToolDescription", ""),
            "invokesSubAgent": elem.get("InvokesSubAgent", False),
        }
        for elem in response.get("Items", [])
    ]


@router.resolver(field_name="listAvailableMcpServers")
@tracer.capture_method
@fetch_user_id(router)
def list_mcp_servers(user_id: str) -> Sequence[Mapping]:
    logger.info(f"User ID {user_id} is querying available MCP servers")

    response = MCP_SERVER_TABLE.scan(Limit=100)  # assuming no more than 100 MCP servers

    results = []
    for elem in response.get("Items", []):
        auth_type = elem.get("AuthType", "SIGV4")
        mcp_url = elem.get("McpUrl", "")

        # Show external servers (NONE auth) regardless of region;
        # filter SigV4 servers to current region only
        if auth_type == "NONE" or REGION_NAME in mcp_url:
            results.append(
                {
                    "name": elem.get("McpServerName", ""),
                    "mcpUrl": mcp_url,
                    "description": elem.get("Description", ""),
                    "authType": auth_type,
                    "source": elem.get("Source", "CDK"),
                }
            )

    return results


# ---- URL Composition (mirrors mcp-seeder/index.py logic) ---- #
def _compose_mcp_url(
    *,
    runtime_id: str | None = None,
    gateway_id: str | None = None,
    qualifier: str = "DEFAULT",
    mcp_url: str | None = None,
) -> str:
    """Compose the MCP endpoint URL from runtimeId/gatewayId or pass-through a direct URL."""
    if mcp_url:
        return mcp_url

    if runtime_id:
        runtime_arn = f"arn:aws:bedrock-agentcore:{REGION_NAME}:{AWS_ACCOUNT_ID}:runtime/{runtime_id}"
        encoded_arn = quote(runtime_arn, safe="")
        return f"https://bedrock-agentcore.{REGION_NAME}.amazonaws.com/runtimes/{encoded_arn}/invocations?qualifier={qualifier}"

    if gateway_id:
        return f"https://{gateway_id}.gateway.bedrock-agentcore.{REGION_NAME}.amazonaws.com/mcp"

    raise ValueError("Must provide runtimeId, gatewayId, or mcpUrl")


def _validate_agentcore_resource(
    runtime_id: str | None, gateway_id: str | None, qualifier: str
) -> bool:
    """Validate that the AgentCore runtime endpoint or gateway exists."""
    try:
        if runtime_id:
            BEDROCK_AGENTCORE.get_agent_runtime_endpoint(
                agentRuntimeId=runtime_id, endpointName=qualifier
            )
            return True
        if gateway_id:
            BEDROCK_AGENTCORE.get_gateway(gatewayIdentifier=gateway_id)
            return True
    except ClientError as err:
        if err.response["Error"]["Code"] == "ResourceNotFoundException":
            logger.warning(
                "AgentCore resource not found",
                extra={
                    "runtimeId": runtime_id,
                    "gatewayId": gateway_id,
                },
            )
            return False
        raise
    return False


# ---- Mutations ---- #
@router.resolver(field_name="registerMcpServer")
@tracer.capture_method
@fetch_user_id(router)
def register_mcp_server(
    user_id: str,
    name: str,
    authType: str,
    runtimeId: str | None = None,
    gatewayId: str | None = None,
    qualifier: str | None = None,
    mcpUrl: str | None = None,
    description: str | None = None,
) -> Mapping:
    logger.info(
        f"User ID {user_id} is registering MCP server: {name}",
        extra={
            "authType": authType,
            "runtimeId": runtimeId,
            "gatewayId": gatewayId,
            "mcpUrl": mcpUrl,
        },
    )

    # Validate name
    if not MCP_SERVER_NAME_PATTERN.match(name):
        return {"id": name, "status": "INVALID_NAME"}

    # Validate auth type
    if authType not in VALID_AUTH_TYPES:
        return {"id": name, "status": "INVALID_CONFIG"}

    effective_qualifier = qualifier or "DEFAULT"

    # Auth-specific validation
    if authType == "SIGV4":
        # Must provide exactly one of runtimeId or gatewayId
        if not runtimeId and not gatewayId:
            return {"id": name, "status": "INVALID_CONFIG"}
        if runtimeId and gatewayId:
            return {"id": name, "status": "INVALID_CONFIG"}
        # Validate the AgentCore resource exists
        if not _validate_agentcore_resource(runtimeId, gatewayId, effective_qualifier):
            return {"id": name, "status": "INVALID_CONFIG"}
    elif authType == "NONE":
        # Must provide a direct URL
        if not mcpUrl or not mcpUrl.startswith("https://"):
            return {"id": name, "status": "INVALID_CONFIG"}

    try:
        # Compose the final URL
        computed_url = _compose_mcp_url(
            runtime_id=runtimeId,
            gateway_id=gatewayId,
            qualifier=effective_qualifier,
            mcp_url=mcpUrl if authType == "NONE" else None,
        )
    except ValueError:
        return {"id": name, "status": "INVALID_CONFIG"}

    try:
        # Check if already exists
        existing = MCP_SERVER_TABLE.get_item(Key={"McpServerName": name})
        if "Item" in existing:
            return {"id": name, "status": "ALREADY_EXISTS"}

        MCP_SERVER_TABLE.put_item(
            Item={
                "McpServerName": name,
                "McpUrl": computed_url,
                "AuthType": authType,
                "Description": description or "",
                "Source": "UI",
            }
        )
        return {"id": name, "status": "SUCCESSFUL"}
    except ClientError as e:
        logger.error(f"Failed to register MCP server: {e}")
        return {"id": name, "status": "SERVICE_ERROR"}


@router.resolver(field_name="deleteMcpServer")
@tracer.capture_method
@fetch_user_id(router)
def delete_mcp_server(user_id: str, name: str) -> Mapping:
    logger.info(f"User ID {user_id} is deleting MCP server: {name}")

    try:
        # Only allow deletion of UI-registered servers
        existing = MCP_SERVER_TABLE.get_item(Key={"McpServerName": name})
        item = existing.get("Item")
        if not item:
            return {"id": name, "status": "INVALID_CONFIG"}

        source = item.get("Source", "CDK")
        if source != "UI":
            logger.warning(f"Refusing to delete CDK-managed MCP server: {name}")
            return {"id": name, "status": "INVALID_CONFIG"}

        MCP_SERVER_TABLE.delete_item(Key={"McpServerName": name})
        return {"id": name, "status": "SUCCESSFUL"}
    except ClientError as e:
        logger.error(f"Failed to delete MCP server: {e}")
        return {"id": name, "status": "SERVICE_ERROR"}
