# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Shared tool and registry utilities for agent implementations.

This module provides:
- Tool implementations (get_current_time, get_weather_forecast)
- Tool object classes (AbstractToolObject, RetrieverTool, InvokeSubAgentTool)
- Tool factory for creating tool instances
- Registry loading utilities from DynamoDB
"""
from __future__ import annotations

import asyncio
import functools
import os
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Callable, Optional

import boto3
from botocore.exceptions import ClientError
from strands import tool

from .base_constants import (
    DYNAMODB_SCAN_LIMIT,
    RETRIEVE_FROM_KB_PREFIX,
)
from .kb_types import RetrievalConfiguration

if TYPE_CHECKING:
    from botocore.client import BaseClient
    from strands.tools.decorator import DecoratedFunctionTool
    from strands.types.tools import JSONSchema


# -------------------------------------------------------------------- #
# Environment variables
# -------------------------------------------------------------------- #
ACCOUNT_ID = os.environ.get("accountId")
REGION_NAME = os.environ.get("AWS_REGION")

RERANK_MODEL_TO_REGIONS = {
    "amazon.rerank-v1:0": ["us-west-2", "eu-central-1", "ap-northeast-1"],
    "cohere.rerank-v3-5:0": [
        "us-east-1",
        "us-west-2",
        "eu-central-1",
        "ap-northeast-1",
    ],
}

# -------------------------------------------------------------------- #
# AWS Clients (lazy initialization)
# -------------------------------------------------------------------- #
_bedrock_agent_client = None
_bedrock_agent_runtime_client = None
_ac_client = None
_acc_client = None


def get_bedrock_agent_client():
    """Get Bedrock Agent client with lazy initialization."""
    global _bedrock_agent_client
    if _bedrock_agent_client is None:
        _bedrock_agent_client = boto3.client(
            "bedrock-agent", region_name=os.environ.get("AWS_REGION")
        )
    return _bedrock_agent_client


def get_bedrock_agent_runtime_client():
    """Get Bedrock Agent Runtime client with lazy initialization."""
    global _bedrock_agent_runtime_client
    if _bedrock_agent_runtime_client is None:
        _bedrock_agent_runtime_client = boto3.client(
            "bedrock-agent-runtime", region_name=os.environ.get("AWS_REGION")
        )
    return _bedrock_agent_runtime_client


def get_agentcore_client():
    """Get Bedrock AgentCore client with lazy initialization."""
    global _ac_client
    if _ac_client is None:
        _ac_client = boto3.client(
            "bedrock-agentcore", region_name=os.environ.get("AWS_REGION")
        )
    return _ac_client


def get_agentcore_control_client():
    """Get Bedrock AgentCore Control client with lazy initialization."""
    global _acc_client
    if _acc_client is None:
        _acc_client = boto3.client(
            "bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION")
        )
    return _acc_client


# -------------------------------------------------------------------- #
# DynamoDB Table Access (lazy initialization)
# -------------------------------------------------------------------- #
_tools_table = None
_mcp_server_table = None


def get_tools_table():
    """
    Get the DynamoDB tools registry table with lazy initialization.

    Returns:
        The DynamoDB Table resource for the tool registry.

    Raises:
        ValueError: If the toolRegistry environment variable is not set.
    """
    global _tools_table
    if _tools_table is None:
        if "toolRegistry" not in os.environ:
            raise ValueError(
                "toolRegistry environment variable is required. "
                "Set it to the name of your DynamoDB tool registry table."
            )
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
        _tools_table = dynamodb.Table(os.environ["toolRegistry"])  # type: ignore[union-attr]
    return _tools_table


def get_mcp_server_table():
    """
    Get the DynamoDB MCP server registry table with lazy initialization.

    Returns:
        The DynamoDB Table resource for the MCP server registry.

    Raises:
        ValueError: If the mcpServerRegistry environment variable is not set.
    """
    global _mcp_server_table
    if _mcp_server_table is None:
        if "mcpServerRegistry" not in os.environ:
            raise ValueError(
                "mcpServerRegistry environment variable is required. "
                "Set it to the name of your DynamoDB MCP server registry table."
            )
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
        _mcp_server_table = dynamodb.Table(os.environ["mcpServerRegistry"])  # type: ignore[union-attr]
    return _mcp_server_table


# -------------------------------------------------------------------- #
## Tool as function definitions commented examples here ##
# -------------------------------------------------------------------- #

# @tool(description=TOOL_DESCRIPTIONS.get("get_weather_forecast"))
# def get_weather_forecast(city: str, days: int = 1) -> str:
#     """Get weather forecast for a city.

#     Dummy agent for demo purposes only

#     Args:
#         city: The name of the city
#         days: Number of days for the forecast
#     """
#     return (
#         "Tomorrow is going to rain"
#         if days == 1
#         else "I cannot tell, let's say is going to be sunny"
#     )


# -------------------------------------------------------------------- #
## Tool as objects definitions ##
# -------------------------------------------------------------------- #
class AbstractToolObject(ABC):
    """Base class for tool defined as objects that can be used with the strands framework.

    This abstract class provides the basic structure for creating tool objects that can be
    decorated and used within the strands framework, and require some configuration parameters

    Args:
        description (str): A description of what the tool does
        name (str): The name identifier for the tool
        context (bool): Whether to include tool context in the implementation
        schema (Optional[JSONSchema]): Optional JSON schema for input validation
        is_async (bool): If True, wraps the synchronous _tool_implementation in an
            async function using asyncio.to_thread so that Strands can invoke
            it concurrently alongside other async tools. Defaults to False.

    Attributes:
        _tool (DecoratedFunctionTool): The decorated tool implementation
    """

    def __init__(
        self,
        description: str,
        name: str,
        context: bool = False,
        schema: Optional[JSONSchema] = None,
        is_async: bool = False,
    ) -> None:
        if is_async:
            sync_impl = self._tool_implementation

            @functools.wraps(sync_impl)
            async def _async_wrapper(**kwargs):
                return await asyncio.to_thread(sync_impl, **kwargs)

            target = _async_wrapper
        else:
            target = self._tool_implementation

        self._tool = tool(
            name=name, description=description, context=context, inputSchema=schema
        )(target)

    def get_tool_description(self) -> str:
        """Gets the description of the tool.

        Returns:
            str: The tool's description or empty string if not set
        """
        return self._tool.tool_spec.get("description", "")

    @property
    def tool(self) -> DecoratedFunctionTool:
        """Gets the decorated tool implementation.

        Returns:
            DecoratedFunctionTool: The decorated tool object
        """
        return self._tool

    @abstractmethod
    def _tool_implementation(self, **kwargs) -> Any:
        """Abstract method that must be implemented by concrete tool classes.

        This method should contain the actual implementation logic for the tool.

        Returns:
            The result of the tool execution.
        """
        pass


class RetrieverTool(AbstractToolObject):
    """
    A tool for retrieving information from an Amazon Bedrock Knowledge Base.

    This class provides functionality to query and retrieve relevant information from a
    specified knowledge base using the Bedrock runtime client.

    Args:
        bedrock_runtime_client (BaseClient): The Bedrock runtime client for making API calls
        bedrock_client (BaseClient): The Bedrock client for accessing KB metadata
        kb_id (str): The ID of the knowledge base to query
        retrieval_cfg (RetrievalConfiguration): Configuration parameters for retrieval

    Attributes:
        retrieve: A decorated function that handles knowledge base queries
    """

    def __init__(
        self,
        bedrock_runtime_client: BaseClient,
        bedrock_client: BaseClient,
        kb_id: str,
        retrieval_cfg: RetrievalConfiguration,
    ):
        self._kb_id = kb_id
        self._cfg = retrieval_cfg.model_dump(mode="json", exclude_none=True)
        self._runtime_client = bedrock_runtime_client

        self._reranking_cfg = None
        self._reranking_client = None

        default_region = REGION_NAME
        reranking_region = None

        if "vectorSearchConfiguration" in self._cfg:
            vector_config = self._cfg["vectorSearchConfiguration"]
            if "rerankingConfiguration" in vector_config:
                self._reranking_cfg = vector_config.pop("rerankingConfiguration")

                model_name = (
                    self._reranking_cfg.get("bedrockRerankingConfiguration", {})
                    .get("modelConfiguration", {})
                    .get("modelArn", "")
                )

                if default_region and default_region in RERANK_MODEL_TO_REGIONS.get(
                    model_name, []
                ):
                    reranking_region = default_region
                else:
                    if default_region and default_region.startswith("us"):
                        reranking_region = "us-east-1"
                    elif default_region and default_region.startswith("eu"):
                        reranking_region = "eu-central-1"
                    elif default_region and default_region.startswith("ap"):
                        reranking_region = "ap-northeast-1"

                if reranking_region:
                    self._reranking_client = boto3.client(
                        "bedrock-agent-runtime", region_name=reranking_region
                    )
                    self._reranking_cfg["bedrockRerankingConfiguration"][
                        "modelConfiguration"
                    ][
                        "modelArn"
                    ] = f"arn:aws:bedrock:{reranking_region}::foundation-model/{model_name}"

        # get KB description
        response = bedrock_client.get_knowledge_base(knowledgeBaseId=self._kb_id)
        kb_description = response["knowledgeBase"]["description"]
        tool_description = f"Retrieves relevant information from a knowledge with the following description: {kb_description}"
        kb_name = response["knowledgeBase"]["name"]

        tool_schema = {
            "json": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language question or search phrase to retrieve relevant information. IMPORTANT: Always use the full conversation context to formulate a complete, specific query.",
                    },
                },
                "required": ["query"],
            }
        }

        super().__init__(
            description=tool_description,
            name=f"{RETRIEVE_FROM_KB_PREFIX}_{kb_name}",
            schema=tool_schema,
        )

    def _tool_implementation(self, query: str) -> dict:
        """
        Retrieves relevant information from a knowledge base using the provided query.

        Args:
            query (str): The text query to search for in the knowledge base

        Returns:
            dict: A dictionary containing the retrieval results from the knowledge base
        """
        payload = {
            "knowledgeBaseId": self._kb_id,
            "retrievalConfiguration": self._cfg,
            "retrievalQuery": {"text": query},
        }
        response = self._runtime_client.retrieve(**payload)
        initial_results = response.get("retrievalResults", [])

        final_results = (
            self._rerank_results(
                query=query,
                results=initial_results,
                reranking_config=self._reranking_cfg,
            )
            if self._reranking_client and self._reranking_cfg
            else initial_results
        )

        data = {"retrievalResults": final_results}
        return {"status": "success", "content": [{"json": data}]}

    def _rerank_results(
        self, query: str, results: list, reranking_config: dict
    ) -> list:
        """Rerank results using the dedicated Bedrock Agent Runtime rerank API."""
        if len(results) <= reranking_config.get(
            "bedrockRerankingConfiguration", {}
        ).get("numberOfResults", 0):
            return results

        if not self._reranking_client:
            top_k = reranking_config["bedrockRerankingConfiguration"]["numberOfResults"]
            return results[:top_k]

        # print(reranking_config)

        try:
            # Prepare sources in the required format
            sources = [
                {
                    "type": "INLINE",
                    "inlineDocumentSource": {
                        "type": "TEXT",
                        "textDocument": {"text": result["content"]["text"]},
                    },
                }
                for result in results
            ]

            # Call the dedicated rerank API
            response = self._reranking_client.rerank(
                queries=[{"type": "TEXT", "textQuery": {"text": query}}],
                sources=sources,
                rerankingConfiguration=reranking_config,
            )

            # Rebuild results in reranked order
            return [
                {**results[item["index"]], "score": item["relevanceScore"]}
                for item in response["results"]
            ]

        except (ClientError, ValueError, KeyError) as err:
            print(f"Reranking failed: {err}")
            top_k = reranking_config["bedrockRerankingConfiguration"]["numberOfResults"]
            return results[:top_k]


## Tool Factory ##


class ToolFactory:
    """Factory class for creating various tool instances.

    All methods return Callable objects that can be used as tools.
    """

    @staticmethod
    def create_retrieval_tool(kb_id: str, cfg: RetrievalConfiguration) -> Callable:
        """Creates a retrieval tool instance with reranking support.

        Args:
            kb_id (str): The ID of the knowledge base to query.
            cfg (RetrievalConfiguration): Configuration parameters for the retrieval.

        Returns:
            Callable: A callable tool instance that can be used to perform retrievals.
        """
        tool_instance = RetrieverTool(
            bedrock_client=get_bedrock_agent_client(),
            bedrock_runtime_client=get_bedrock_agent_runtime_client(),
            kb_id=kb_id,
            retrieval_cfg=cfg,
        )

        return tool_instance.tool

    # @staticmethod
    # def create_get_weather_forecast() -> Callable:
    #     """Creates a tool instance for getting weather forecasts.

    #     Returns:
    #         Callable: A callable tool instance that retrieves weather forecast data.
    #     """
    #     return get_weather_forecast


# Tool name to factory mapping
TOOL_FACTORY_MAP = {
    # "get_weather_forecast": ToolFactory.create_get_weather_forecast,
}


def load_tools_from_dynamodb(
    tool_factory_map: Optional[dict[str, Callable]] = None,
) -> dict[str, dict[str, Any]]:
    """
    Load tools from DynamoDB and map to factory methods.

    Scans the tool registry table and creates a mapping of tool names
    to their factory functions and metadata.

    Args:
        tool_factory_map: Optional mapping of tool names to factory functions.
                         Defaults to TOOL_FACTORY_MAP if not provided.

    Returns:
        Dictionary mapping tool names to their configuration and factory functions.

    Raises:
        ValueError: If the toolRegistry environment variable is not set.
    """
    if tool_factory_map is None:
        tool_factory_map = TOOL_FACTORY_MAP

    tools_table = get_tools_table()
    response = tools_table.scan(Limit=DYNAMODB_SCAN_LIMIT)
    tools: dict[str, dict[str, Any]] = {}

    # Handle pagination for large tool registries
    while True:
        for item in response.get("Items", []):
            tool_name = item.get("ToolName", "")
            if tool_name in tool_factory_map:
                tools[tool_name] = {
                    "description": item.get("ToolDescription", ""),
                    "factory": tool_factory_map[tool_name],
                    "invokes_sub_agent": item.get("InvokesSubAgent", False),
                }

        # Check if there are more items to scan
        if "LastEvaluatedKey" not in response:
            break
        response = tools_table.scan(
            Limit=DYNAMODB_SCAN_LIMIT,
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )

    # Add special tools
    tools[RETRIEVE_FROM_KB_PREFIX] = {
        "factory": ToolFactory.create_retrieval_tool,
        "include_in_list": False,
    }

    return tools


def load_mcps_from_dynamodb(
    filter_by_region: bool = False,
) -> dict[str, dict[str, Any]]:
    """
    Load MCP servers from DynamoDB.

    Scans the MCP server registry table and creates a mapping of server names
    to their URLs.

    Args:
        filter_by_region: If True, only include MCP servers whose URL contains
                         the current AWS region.

    Returns:
        Dictionary mapping MCP server names to their configuration.

    Raises:
        ValueError: If the mcpServerRegistry environment variable is not set.
    """
    mcp_server_table = get_mcp_server_table()
    response = mcp_server_table.scan(Limit=DYNAMODB_SCAN_LIMIT)
    mcp_servers: dict[str, dict[str, Any]] = {}

    # Handle pagination for large registries
    while True:
        for item in response.get("Items", []):
            mcp_server_name = item.get("McpServerName", "")
            mcp_url = item.get("McpUrl", "")

            auth_type = item.get("AuthType", "SIGV4")

            # Optionally filter by region (skip for external servers with no auth)
            if filter_by_region and auth_type != "NONE":
                if REGION_NAME and REGION_NAME in mcp_url:
                    mcp_servers[mcp_server_name] = {
                        "McpUrl": mcp_url,
                        "AuthType": auth_type,
                    }
            else:
                mcp_servers[mcp_server_name] = {
                    "McpUrl": mcp_url,
                    "AuthType": auth_type,
                }

        # Check if there are more items to scan
        if "LastEvaluatedKey" not in response:
            break
        response = mcp_server_table.scan(
            Limit=DYNAMODB_SCAN_LIMIT,
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )

    return mcp_servers
