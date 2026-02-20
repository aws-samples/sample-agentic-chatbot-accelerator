# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
from typing import Mapping, Sequence

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
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

    return [
        {
            "name": elem.get("McpServerName", ""),
            "mcpUrl": elem.get("McpUrl", ""),
            "description": elem.get("Description", ""),
        }
        for elem in response.get("Items", [])
        if REGION_NAME
        in elem.get(
            "McpUrl", ""
        )  # only display mcp servers that are in the same region as the stack
    ]
