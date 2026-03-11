# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
import re
from typing import Mapping, Sequence

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

# ----------------------- Environment Variables ---------------------- #
REGION_NAME = os.environ["REGION_NAME"]
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
                }
            )

    return results


# ---- Mutations ---- #
@router.resolver(field_name="registerMcpServer")
@tracer.capture_method
@fetch_user_id(router)
def register_mcp_server(
    user_id: str,
    name: str,
    mcpUrl: str,
    authType: str,
    description: str | None = None,
) -> Mapping:
    logger.info(
        f"User ID {user_id} is registering MCP server: {name}",
        extra={"mcpUrl": mcpUrl, "authType": authType},
    )

    # Validate name
    if not MCP_SERVER_NAME_PATTERN.match(name):
        return {"id": name, "status": "INVALID_NAME"}

    # Validate auth type
    if authType not in VALID_AUTH_TYPES:
        return {"id": name, "status": "INVALID_CONFIG"}

    # Validate URL
    if not mcpUrl.startswith("https://"):
        return {"id": name, "status": "INVALID_CONFIG"}

    try:
        # Check if already exists
        existing = MCP_SERVER_TABLE.get_item(Key={"McpServerName": name})
        if "Item" in existing:
            return {"id": name, "status": "ALREADY_EXISTS"}

        MCP_SERVER_TABLE.put_item(
            Item={
                "McpServerName": name,
                "McpUrl": mcpUrl,
                "AuthType": authType,
                "Description": description or "",
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
        MCP_SERVER_TABLE.delete_item(Key={"McpServerName": name})
        return {"id": name, "status": "SUCCESSFUL"}
    except ClientError as e:
        logger.error(f"Failed to delete MCP server: {e}")
        return {"id": name, "status": "SERVICE_ERROR"}
