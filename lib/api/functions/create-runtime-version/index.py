# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
import time
from typing import Optional, Union

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError
from genai_core.api_helper.types import AgentConfiguration, ArchitectureType
from genai_core.exceptions import AcaException

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="graphQL-startRuntimeCreation")
logger = Logger(service="graphQL-startRuntimeCreation")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
CONTAINER_URI = os.environ["CONTAINER_URI"]
SWARM_CONTAINER_URI = os.environ.get("SWARM_CONTAINER_URI", "")
AGENT_CORE_RUNTIME_ROLE_ARN = os.environ["AGENT_CORE_RUNTIME_ROLE_ARN"]
AGENT_CORE_RUNTIME_TABLE = os.environ["AGENT_CORE_RUNTIME_TABLE"]
TOOL_REGISTRY_TABLE = os.environ["TOOL_REGISTRY_TABLE"]
MCP_SERVER_REGISTRY_TABLE = os.environ["MCP_SERVER_REGISTRY_TABLE"]
AGENT_TOOLS_TOPIC_ARN = os.environ["AGENT_TOOLS_TOPIC_ARN"]
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
AGENTS_TABLE_NAME = os.environ.get("AGENTS_TABLE_NAME", "")
AGENTS_SUMMARY_TABLE_NAME = os.environ.get("AGENTS_SUMMARY_TABLE_NAME", "")

ENVIRONMENT_TAG = os.environ.get("ENVIRONMENT_TAG", None)
STACK_TAG = os.environ.get("STACK_TAG", None)

PAGE_SIZE = 20
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentName: str
    agentCfg: Union[AgentConfiguration, dict]
    memoryId: Optional[str] = None
    architectureType: str = ArchitectureType.SINGLE.value


class Body(BaseModel):
    agentRuntimeId: str
    agentRuntimeArn: str
    agentRuntimeVersion: str
    createdAt: int


class OutputModel(BaseModel):
    status: int
    body: Body


class AgentIdentifier(BaseModel):
    agentRuntimeId: str
    agentRuntimeArn: str


@tracer.capture_method
def get_runtime_id(agent_name: str) -> Optional[AgentIdentifier]:
    """Retrieves the runtime ID and ARN for a given agent name.

    Paginates through all agent runtimes to find one matching the specified name.

    Args:
        agent_name (str): The name of the agent runtime to search for.

    Returns:
        Optional[AgentIdentifier]: An AgentIdentifier object containing the runtime ID
            and ARN if found, None otherwise.
    """
    next_token = None
    agent: Optional[AgentIdentifier] = None
    while True:
        api_arguments = {"maxResults": PAGE_SIZE}
        if next_token:
            api_arguments["nextToken"] = next_token
        response = BAC_CLIENT.list_agent_runtimes(**api_arguments)
        next_token = response.get("nextToken")
        for elem in response.get("agentRuntimes", []):
            if elem["agentRuntimeName"] == agent_name:
                agent = AgentIdentifier(
                    agentRuntimeId=elem["agentRuntimeId"],
                    agentRuntimeArn=elem["agentRuntimeArn"],
                )
                break

        if not next_token or agent:
            break

    return agent


@tracer.capture_method
def tags_match(runtime_arn: str) -> bool:
    """Checks if the tags on a runtime match the expected environment and stack tags.

    Retrieves tags from the specified runtime ARN and verifies that both
    Environment and Stack tags match the configured values.

    Args:
        runtime_arn (str): The ARN of the agent runtime to check tags for.

    Returns:
        bool: True if both Environment and Stack tags match the expected values,
            False otherwise.
    """
    response = BAC_CLIENT.list_tags_for_resource(resourceArn=runtime_arn)

    tags = response.get("tags", {})

    return tags.get("Environment") == ENVIRONMENT_TAG and tags.get("Stack") == STACK_TAG


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Lambda handler to create or update an AgentCore runtime version.

    Creates a new agent runtime or updates an existing one with a new version.
    If the agent already exists, verifies that tags match before updating.
    Optionally attaches a memory ID if configured.

    Args:
        event (InputModel): The input event containing:
            - agentName: Name of the agent runtime
            - agentCfg: Agent configuration including memory settings
            - memoryId: Optional memory ID to attach
        _ : Lambda context (unused).

    Raises:
        ClientError: If listing runtimes or creating/updating runtime fails.
        AcaException: If attempting to add a version to a runtime created
            from a different stack/environment.

    Returns:
        dict: Response containing status code and body with:
            - agentRuntimeId: The runtime ID
            - agentRuntimeArn: The runtime ARN
            - agentRuntimeVersion: The created/updated version
            - createdAt: Timestamp of creation
    """
    try:
        agent = get_runtime_id(event.agentName)
    except ClientError as err:
        logger.error(
            "Failed to list AgentCore Runtimes", extra={"rawErrorMessage": str(err)}
        )
        logger.exception(err)
        raise err

    created_at = int(time.time())

    # Select container URI based on architecture type
    is_swarm = event.architectureType == ArchitectureType.SWARM.value
    container_uri = SWARM_CONTAINER_URI if is_swarm else CONTAINER_URI

    if is_swarm and not SWARM_CONTAINER_URI:
        err_msg = f"SWARM_CONTAINER_URI environment variable is not set but architectureType is {ArchitectureType.SWARM.value}"
        logger.error(err_msg)
        raise AcaException(err_msg)

    api_args = {
        "agentRuntimeArtifact": {
            "containerConfiguration": {
                "containerUri": container_uri,
            }
        },
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "roleArn": AGENT_CORE_RUNTIME_ROLE_ARN,
        "environmentVariables": {
            "tableName": AGENT_CORE_RUNTIME_TABLE,
            "toolRegistry": TOOL_REGISTRY_TABLE,
            "mcpServerRegistry": MCP_SERVER_REGISTRY_TABLE,
            "agentName": event.agentName,
            "createdAt": str(created_at),
            "accountId": ACCOUNT_ID,
            "agentToolsTopicArn": AGENT_TOOLS_TOPIC_ARN,
        },
    }

    if is_swarm:
        if not AGENTS_TABLE_NAME or not AGENTS_SUMMARY_TABLE_NAME:
            err_msg = f"AGENTS_TABLE_NAME and AGENTS_SUMMARY_TABLE_NAME environment variables must be set for {ArchitectureType.SWARM.value} architecture"
            logger.error(err_msg)
            raise ValueError(err_msg)
        api_args["environmentVariables"]["agentsTableName"] = AGENTS_TABLE_NAME
        api_args["environmentVariables"][
            "agentsSummaryTableName"
        ] = AGENTS_SUMMARY_TABLE_NAME

    if agent:
        logger.info(
            f"Agent {event.agentName} already exists --> updating version of runtime"
        )
        api_args["agentRuntimeId"] = agent.agentRuntimeId

        if not tags_match(agent.agentRuntimeArn):
            err_msg = "It is not possible to add a version to a runtime that was not created from the same stack and environment"
            logger.error(err_msg)
            raise AcaException(err_msg)
    else:
        logger.info(f"Creating a new AgentCore runtime for agent {event.agentName}")
        api_args["agentRuntimeName"] = event.agentName
        api_args["tags"] = {
            "Stack": STACK_TAG,
        }
        if ENVIRONMENT_TAG:
            api_args["tags"]["Environment"] = ENVIRONMENT_TAG

    if (
        hasattr(event.agentCfg, "useMemory")
        and event.agentCfg.useMemory
        and event.memoryId
    ):
        logger.info(f"Attaching created AgentCore memory {event.memoryId}")
        api_args["environmentVariables"]["memoryId"] = event.memoryId
    elif (
        isinstance(event.agentCfg, dict)
        and event.agentCfg.get("useMemory")
        and event.memoryId
    ):
        logger.info(f"Attaching created AgentCore memory {event.memoryId}")
        api_args["environmentVariables"]["memoryId"] = event.memoryId

    api_func = (
        BAC_CLIENT.update_agent_runtime if agent else BAC_CLIENT.create_agent_runtime
    )

    try:
        response = api_func(**api_args)
    except ClientError as err:
        logger.error(
            "Failed to create AgentCore Runtime", extra={"rawErrorMessage": str(err)}
        )
        logger.exception(err)
        raise err

    agent_runtime_arn = response.get("agentRuntimeArn")
    agent_runtime_id = response.get("agentRuntimeId")
    agent_runtime_version = response.get("agentRuntimeVersion")

    logger.info(
        "Creation correctly started",
        extra={
            "metadata": {
                "agentRuntimeArn": agent_runtime_arn,
                "agentRuntimeId": agent_runtime_id,
                "agentRuntimeVersion": agent_runtime_version,
            }
        },
    )

    return OutputModel(
        status=200,
        body=Body(
            agentRuntimeId=agent_runtime_id,
            agentRuntimeArn=agent_runtime_arn,
            agentRuntimeVersion=agent_runtime_version,
            createdAt=created_at,
        ),
    ).model_dump()
