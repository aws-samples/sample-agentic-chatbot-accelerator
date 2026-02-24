# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
# TODO: Remove code duplication - consider moving shared code to a common module
"""
Tool and MCP Server Registry Module.

This module provides:
- Tool implementations (get_current_time, get_weather_forecast)
- Tool object classes (RetrieverTool, InvokeSubAgentTool)
- Tool factory for creating tool instances
- Registry loading from DynamoDB for tools and MCP servers

The registries are loaded at module initialization from DynamoDB tables
specified via environment variables (toolRegistry, mcpServerRegistry).
"""
from __future__ import annotations

import json
import os
import uuid
from abc import ABC, abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable

import boto3
from botocore.exceptions import ClientError
from dateutil import tz
from strands import ToolContext, tool

from .constants import (
    DEFAULT_TIME_ZONE,
    INVOKE_SUBAGENT_PREFIX,
    RETRIEVE_FROM_KB_PREFIX,
    TOOL_DESCRIPTIONS,
)
from .types import RetrievalConfiguration

if TYPE_CHECKING:
    from botocore.client import BaseClient
    from strands.tools.decorator import DecoratedFunctionTool

# --------------------------- CONSTANTS --------------------------- #
DYNAMODB_SCAN_LIMIT = 100  # Maximum items to retrieve per DynamoDB scan

# --------------------------- AWS CLIENTS --------------------------- #
BEDROCK_AGENT_CLIENT = boto3.client(
    "bedrock-agent", region_name=os.environ.get("AWS_REGION")
)
BEDROCK_AGENT_RUNTIME_CLIENT = boto3.client(
    "bedrock-agent-runtime", region_name=os.environ.get("AWS_REGION")
)
AC_CLIENT = boto3.client("bedrock-agentcore", region_name=os.environ.get("AWS_REGION"))
ACC_CLIENT = boto3.client(
    "bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION")
)
ACCOUNT_ID = os.environ.get("accountId")
REGION_NAME = os.environ.get("AWS_REGION")


# -------------------------------------------------------------------- #
# DynamoDB Table Access (lazy initialization)
# -------------------------------------------------------------------- #
_tools_table = None
_mcp_server_table = None


def _get_tools_table():
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


def _get_mcp_server_table():
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
## Tool as function definitions ##
# -------------------------------------------------------------------- #
@tool(description=TOOL_DESCRIPTIONS.get("get_current_time"))
def get_current_time(
    timezone: str = DEFAULT_TIME_ZONE, time_format: str = "%Y-%m-%d %H:%M:%S.%f"
) -> str:
    """
    Tool for the LLM to know what time it is.

    Args:
        timezone: The timezone to get the current date and time for (e.g., "UTC", "America/New_York")
        time_format: Optional format for the date and time (e.g., %Y-%m-%d %H:%M:%S.%f)

    Returns:
        str: Current date-time formatted string
    """
    # Get the current datetime
    now_tz = datetime.now(tz=tz.gettz(timezone))

    # Convert to string
    now_tz_str = now_tz.strftime(time_format)

    return f"Current date-time is {now_tz_str} in time zone {timezone}, formatted as {time_format}"


@tool(description=TOOL_DESCRIPTIONS.get("get_weather_forecast"))
def get_weather_forecast(city: str, days: int = 1) -> str:
    """Get weather forecast for a city.

    Dummy agent for demo purposes only

    Args:
        city: The name of the city
        days: Number of days for the forecast
    """
    return (
        "Tomorrow is going to rain"
        if days == 1
        else "I cannot tell, let's say is going to be sunny"
    )


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

    Attributes:
        _tool (DecoratedFunctionTool): The decorated tool implementation
    """

    def __init__(self, description: str, name: str, context: bool = False) -> None:
        self._tool = tool(name=name, description=description, context=context)(
            self._tool_implementation
        )

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
        self._cfg = retrieval_cfg
        self._runtime_client = bedrock_runtime_client

        # get KB description
        response = bedrock_client.get_knowledge_base(knowledgeBaseId=self._kb_id)
        kb_description = response["knowledgeBase"]["description"]
        kb_name = response["knowledgeBase"]["name"]

        super().__init__(
            description=f"Retrieves relevant information from a knowledge with the following description: {kb_description}",
            name=f"{RETRIEVE_FROM_KB_PREFIX}_{kb_name}",
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
            "retrievalConfiguration": self._cfg.model_dump(
                mode="json", exclude_none=True
            ),
            "retrievalQuery": {"text": query},
        }
        response = self._runtime_client.retrieve(**payload)

        data = {"retrievalResults": response.get("retrievalResults")}
        return {"status": "success", "content": [{"json": data}]}


class InvokeSubAgentTool(AbstractToolObject):
    """A tool for invoking sub-agents to process specialized tasks.

    This class enables delegation of specific queries to specialized sub-agents hosted on Amazon Bedrock AgentCore.

    Args:
        agent_runtime_arn (str): The ARN of the agent runtime to invoke
        agent_name (str): The name identifier of the sub-agent
        logger (Logger): Logger instance for tracking operations
        agent_role (str): Description of the sub-agent's role and capabilities
        qualifier (str, optional): Agent version qualifier. Defaults to "DEFAULT"

    """

    def __init__(
        self,
        agent_name: str,
        agent_role: str,
        qualifier: str = "DEFAULT",
    ) -> None:
        self._agent_name = agent_name
        self._agent_runtime_arn = self._fetch_agent_runtime()
        if self._agent_runtime_arn is None:
            raise RuntimeError(f"Agent runtime not found for agent name: {agent_name}")
        self._qualifier = qualifier

        super().__init__(
            description=agent_role,
            name=f"{INVOKE_SUBAGENT_PREFIX}_{agent_name}",
            context=True,
        )

    def _fetch_agent_runtime(self) -> str | None:
        """
        Map agent name to runtime ARN.

        Returns:
            The agent runtime ID if found, None otherwise.
        """
        next_token = None
        agent_runtime_id = None
        while True:
            api_arguments = {"maxResults": 10}
            if next_token:
                api_arguments["nextToken"] = next_token
            response = ACC_CLIENT.list_agent_runtimes(**api_arguments)
            next_token = response.get("nextToken")
            for elem in response.get("agentRuntimes", []):
                if elem["agentRuntimeName"] == self._agent_name:
                    agent_runtime_id = elem["agentRuntimeId"]

            if not next_token or agent_runtime_id:
                break

        return agent_runtime_id

    def _tool_implementation(self, query: str, tool_context: ToolContext) -> str:
        """Invokes a sub-agent to process the given query.

        Args:
            query (str): Stringified JSON that contains the payload specified in the tool description.

        Returns:
            str: The response from the sub-agent, or an error message if the sub-agent fails.

        Raises:
            Exception: If the sub-agent encounters an error during processing.
        """
        user_id = tool_context.invocation_state.get("userId", "default")
        session_id = tool_context.invocation_state.get("sessionId", str(uuid.uuid4()))
        session_id += f"-sa-{self._agent_name}"

        try:
            payload = json.dumps(
                {
                    "prompt": query,
                    "userId": user_id,
                }
            ).encode()

            response = AC_CLIENT.invoke_agent_runtime(
                agentRuntimeArn=self._agent_runtime_arn,
                runtimeSessionId=session_id,
                runtimeUserId=user_id,
                payload=payload,
                qualifier=self._qualifier,
                accountId=ACCOUNT_ID,
            )
            response_body = response["response"].read()
            sub_agent_response = json.loads(response_body)
        except ClientError as err:
            sub_agent_response = (
                f"Error in the sub-agent responsible for "
                f"{self.get_tool_description()}: {str(err)}"
            )

        return sub_agent_response


## Tool Factory ##


class ToolFactory:
    """Factory class for creating various tool instances.

    All methods return Callable objects that can be used as tools.
    """

    @staticmethod
    def create_retrieval_tool(kb_id: str, cfg: RetrievalConfiguration) -> Callable:
        """Creates a retrieval tool instance for querying knowledge bases.

        Args:
            kb_id (str): The ID of the knowledge base to query.
            cfg (RetrievalConfiguration): Configuration parameters for the retrieval.

        Returns:
            Callable: A callable tool instance that can be used to perform retrievals.
        """
        tool_instance = RetrieverTool(
            bedrock_client=BEDROCK_AGENT_CLIENT,
            bedrock_runtime_client=BEDROCK_AGENT_RUNTIME_CLIENT,
            kb_id=kb_id,
            retrieval_cfg=cfg,
        )

        return tool_instance.tool

    @staticmethod
    def create_get_current_time() -> Callable:
        """Creates a tool instance for getting the current time.

        Returns:
            Callable: A callable tool instance that returns the current time.
        """
        return get_current_time

    @staticmethod
    def create_get_weather_forecast() -> Callable:
        """Creates a tool instance for getting weather forecasts.

        Returns:
            Callable: A callable tool instance that retrieves weather forecast data.
        """
        return get_weather_forecast

    @staticmethod
    def create_invoke_subagent_tool(
        agentName: str, qualifier: str, role: str
    ) -> Callable:
        """Creates a tool instance for invoking a sub-agent.

        Args:
            user_id (str): The ID of the user making the request.
            session_id (str): The session ID where the orchestrator is running
            agentName (str): Name of the sub-agent to invoke.
            qualifier (int): The version of the Bedrock AgentCore Runtime endpoint.
            role (str): Role assigned to the sub-agent, used for tool description

        Returns:
            Callable: A callable tool instance that can invoke the specified sub-agent.
        """
        tool_instance = InvokeSubAgentTool(
            agent_name=agentName,
            agent_role=role,
            qualifier=qualifier,
        )
        return tool_instance.tool


def _load_tools_from_dynamodb() -> dict[str, dict[str, Any]]:
    """
    Load tools from DynamoDB and map to factory methods.

    Scans the tool registry table and creates a mapping of tool names
    to their factory functions and metadata.

    Returns:
        Dictionary mapping tool names to their configuration and factory functions.

    Raises:
        ValueError: If the toolRegistry environment variable is not set.
    """
    tools_table = _get_tools_table()
    response = tools_table.scan(Limit=DYNAMODB_SCAN_LIMIT)
    tools: dict[str, dict[str, Any]] = {}

    # Handle pagination for large tool registries
    while True:
        for item in response.get("Items", []):
            tool_name = item.get("ToolName", "")
            if tool_name in TOOL_FACTORY_MAP:
                tools[tool_name] = {
                    "description": item.get("ToolDescription", ""),
                    "factory": TOOL_FACTORY_MAP[tool_name],
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


def _load_mcps_from_dynamodb() -> dict[str, dict[str, Any]]:
    """
    Load MCP servers from DynamoDB.

    Scans the MCP server registry table and creates a mapping of server names
    to their URLs. Only includes servers deployed in the same AWS region.

    Returns:
        Dictionary mapping MCP server names to their configuration.

    Raises:
        ValueError: If the mcpServerRegistry environment variable is not set.
    """
    mcp_server_table = _get_mcp_server_table()
    response = mcp_server_table.scan(Limit=DYNAMODB_SCAN_LIMIT)
    mcp_servers: dict[str, dict[str, Any]] = {}

    # Handle pagination for large registries
    while True:
        for item in response.get("Items", []):
            mcp_server_name = item.get("McpServerName", "")
            mcp_url = item.get("McpUrl", "")
            # Only use MCP servers deployed in the same region
            # Check if region appears in the URL (e.g., in the endpoint domain)
            if REGION_NAME and REGION_NAME in mcp_url:
                mcp_servers[mcp_server_name] = {
                    "McpUrl": mcp_url,
                }

        # Check if there are more items to scan
        if "LastEvaluatedKey" not in response:
            break
        response = mcp_server_table.scan(
            Limit=DYNAMODB_SCAN_LIMIT,
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )

    return mcp_servers


# Tool name to factory mapping
TOOL_FACTORY_MAP = {
    "get_current_time": ToolFactory.create_get_current_time,
    "get_weather_forecast": ToolFactory.create_get_weather_forecast,
    "invoke_subagent": ToolFactory.create_invoke_subagent_tool,
}

# Replace the hardcoded AVAILABLE_TOOLS with:
AVAILABLE_TOOLS: dict[str, dict[str, Any]] = _load_tools_from_dynamodb()
AVAILABLE_MCPS: dict[str, dict[str, Any]] = _load_mcps_from_dynamodb()
