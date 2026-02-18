# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Callable, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import AppSyncResolver
from aws_lambda_powertools.logging import correlation_paths
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from genai_core.api_helper.types import (
    AgentConfiguration,
    ArchitectureType,
    SwarmConfiguration,
)
from pydantic import ValidationError
from retry import retry

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="graphQL-createAgentCoreRuntime")
app = AppSyncResolver()
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
AGENT_TABLE_NAME = None
CONTAINER_URI = os.environ["CONTAINER_URI"]
AGENT_CORE_RUNTIME_ROLE_ARN = os.environ["AGENT_CORE_RUNTIME_ROLE_ARN"]
ENVIRONMENT_TAG = os.environ.get("ENVIRONMENT_TAG")
STACK_TAG = os.environ.get("STACK_TAG", "aca")
AGENT_CORE_RUNTIME_TABLE = os.environ["AGENT_CORE_RUNTIME_TABLE"]
AGENT_CORE_SUMMARY_TABLE = os.environ["AGENT_CORE_SUMMARY_TABLE"]
TOOL_REGISTRY_TABLE = os.environ["TOOL_REGISTRY_TABLE"]
MCP_SERVER_REGISTRY_TABLE = os.environ["MCP_SERVER_REGISTRY_TABLE"]
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
EVENT_EXPIRE_DAYS = int(os.environ.get("EVENT_EXPIRE_DAYS", "90"))
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
SFN_CLIENT = boto3.client("stepfunctions")
TABLE = boto3.resource("dynamodb").Table(AGENT_CORE_RUNTIME_TABLE)  # type: ignore
SUMMARY_TABLE = boto3.resource("dynamodb").Table(AGENT_CORE_SUMMARY_TABLE)  # type: ignore
# ---------------------------------------------------------- #


# Routes
@app.resolver(type_name="Mutation", field_name="createAgentCoreRuntime")
def create_agent_runtime(
    agentName: str, configValue: str, architectureType: Optional[str] = None
) -> str:
    """Creates a new AgentCore Runtime by starting a Step Function execution.

    This function validates the provided agent configuration and initiates an asynchronous
    runtime creation process via AWS Step Functions. Based on the architectureType, it
    validates against either AgentConfiguration (single) or SwarmConfiguration (swarm).

    Args:
        agentName (str): The unique name identifier for the agent runtime to be created.
        configValue (str): A JSON string containing the agent configuration.
        architectureType (Optional[str]): "SINGLE" or "SWARM". Defaults to "SINGLE".

    Returns:
        str: The agentName if the Step Function execution started successfully, or an empty
            string if validation fails or the Step Function execution could not be started.

    Raises:
        Does not raise exceptions directly; all errors are logged and result in returning
        an empty string.
    """
    resolved_architecture = architectureType or ArchitectureType.SINGLE.value

    state_machine_arn = os.environ["CREATE_RUNTIME_STATE_MACHINE_ARN"]
    try:
        parsed_config = json.loads(configValue)
    except json.decoder.JSONDecodeError as err:
        logger.error(
            "The configuration value is not a valid JSON string",
            extra={"rawErrorMessage": str(err)},
        )
        return ""

    try:
        if resolved_architecture == ArchitectureType.SWARM.value:
            parsed_config = SwarmConfiguration.model_validate_json(configValue)
        elif resolved_architecture == ArchitectureType.SINGLE.value:
            parsed_config = AgentConfiguration.model_validate_json(configValue)
        else:
            raise AssertionError(
                f"Add implementation for architecture {resolved_architecture}"
            )
    except ValidationError as err:
        logger.error(
            "The configuration value is not a valid agent configuration",
            extra={"rawErrorMessage": str(err)},
        )
        return ""

    logger.info(
        "Create a new AgentCore Runtime",
        extra={
            "arguments": {
                "name": agentName,
                "architectureType": resolved_architecture,
                "configuration": parsed_config.model_dump(),
            }
        },
    )

    try:
        SFN_CLIENT.start_execution(
            stateMachineArn=state_machine_arn,
            input=json.dumps(
                {
                    "agentName": agentName,
                    "agentConfiguration": parsed_config.model_dump(),
                    "architectureType": resolved_architecture,
                }
            ),
        )
        logger.info(
            f"Started Step Function execution for creating runtime of agent {agentName}"
        )
        return agentName
    except ClientError as err:
        logger.error(
            "Failed to start Step Function execution",
            extra={"rawErrorMessage": str(err)},
        )
        return ""


@app.resolver(type_name="Query", field_name="listRuntimeAgents")
def list_runtime_agents() -> list[dict]:
    """Retrieves all agent runtime summaries from DynamoDB.

    Returns:
        list[dict]: List of agent runtime summaries, each containing:
            - agentName: Name of the agent
            - agentRuntimeId: Runtime ID of the agent
            - numberOfVersion: Number of versions for the agent
            - qualifierToVersion: JSON string mapping qualifiers to versions
    """
    try:
        response = SUMMARY_TABLE.scan()
        items = response["Items"]

        while "LastEvaluatedKey" in response:
            response = SUMMARY_TABLE.scan(
                ExclusiveStartKey=response["LastEvaluatedKey"]
            )
            items.extend(response["Items"])

        logger.info("Items", extra={"dynamoItems": items})

    except ClientError as err:
        logger.error(
            "Scan operation of table failed",
            extra={"rawErrorMessage": str(err)},
        )
        return []

    return [
        {
            "agentName": item.get("AgentName", "???"),
            "agentRuntimeId": item.get("AgentRuntimeId", "???"),
            "numberOfVersion": item.get("NumberOfVersions", "0"),
            "qualifierToVersion": json.dumps(
                item.get("QualifierToVersion", {}), default=str
            ),
            "status": item.get("Status", "Ready"),
            "architectureType": item.get(
                "ArchitectureType", ArchitectureType.SINGLE.value
            ),
        }
        for item in items
    ]


@app.resolver(type_name="Query", field_name="getRuntimeConfigurationByVersion")
def get_runtime_cfg_by_version(agentName: str, agentVersion: str) -> str:
    """Retrieves agent runtime configuration for a specific version.

    Args:
        agentName (str): Name of the agent
        agentVersion (str): Version of the agent runtime

    Returns:
        str: JSON configuration string for the specified agent version, empty string if not found
    """
    try:
        response = TABLE.query(
            IndexName="byAgentNameAndVersion",
            KeyConditionExpression=Key("AgentName").eq(agentName)
            & Key("AgentRuntimeVersion").eq(agentVersion),
        )
        items = response.get("Items", [])
        return items[0].get("ConfigurationValue", "") if items else ""
    except ClientError as err:
        logger.error(
            "Failed to query runtime configuration", extra={"rawErrorMessage": str(err)}
        )
        return ""


@app.resolver(type_name="Query", field_name="getRuntimeConfigurationByQualifier")
def get_runtime_cfg_by_qualifier(agentName: str, qualifier: str) -> str:
    """Retrieves agent runtime configuration using a qualifier.

    Args:
        agentName (str): Name of the agent
        qualifier (str): Qualifier to map to a specific version

    Returns:
        str: JSON configuration string for the agent version mapped to the qualifier, empty string if not found
    """
    return _get_runtime_cfg_by_qualifier_impl(agentName, qualifier)


@app.resolver(type_name="Query", field_name="getDefaultRuntimeConfiguration")
def get_default_runtime_cfg(agentName: str) -> str:
    """Retrieves the default runtime configuration for an agent.

    Args:
        agentName (str): Name of the agent

    Returns:
        str: JSON configuration string for the default agent version, empty string if not found
    """
    return _get_runtime_cfg_by_qualifier_impl(agentName, "DEFAULT")


@app.resolver(type_name="Mutation", field_name="tagAgentCoreRuntime")
def tag_agent_core_runtime(
    agentName: str,
    agentRuntimeId: str,
    currentQualifierToVersion: str,
    agentVersion: str,
    qualifier: str,
    description: Optional[str] = None,
) -> str:
    """Creates an agent runtime endpoint with a qualifier and updates version mapping.

    Args:
        agentName (str): Name of the agent
        agentRuntimeId (str): ID of the agent runtime
        currentQualifierToVersion (str): JSON string mapping current qualifiers to versions
        agentVersion (str): Version of the agent runtime to tag
        qualifier (str): Qualifier name for the endpoint
        description (Optional[str], optional): Description for the endpoint. Defaults to None.

    Returns:
        str: The qualifier name if successful, empty string if failed
    """
    # create the runtime endpoint
    try:
        args = {
            "agentRuntimeId": agentRuntimeId,
            "name": qualifier,
            "agentRuntimeVersion": agentVersion,
            "tags": {
                "Stack": STACK_TAG,
                "Environment": ENVIRONMENT_TAG,
            },
        }
        if description:
            args["description"] = description
        BAC_CLIENT.create_agent_runtime_endpoint(**args)
    except ClientError as err:
        logger.error(
            "Failed to create agent endpoint", extra={"rawErrorMessage": str(err)}
        )
        return ""

    status = _check_on_endpoint_creation(agentRuntimeId, qualifier)
    if status != "READY":
        logger.info(f"Endpoint creation failed: {status}")
        return ""
    logger.info("Created endpoint")

    # update the SUMMARY_TABLE
    qualifier_to_version = json.loads(currentQualifierToVersion)
    qualifier_to_version[qualifier] = int(agentVersion)

    try:
        SUMMARY_TABLE.update_item(
            Key={"AgentName": agentName},
            UpdateExpression="SET QualifierToVersion = :qtv",
            ExpressionAttributeValues={
                ":qtv": qualifier_to_version,
            },
        )
    except ClientError as err:
        logger.error(
            "Failed to update the runtime summary table",
            extra={"rawErrorMessage": str(err)},
        )
        return ""

    logger.info(
        "Updated qualifier to version",
        extra={"qualifierToVersion": qualifier_to_version},
    )

    return qualifier


@app.resolver(type_name="Query", field_name="listAgentVersions")
def list_agent_versions(agentRuntimeId: str) -> list[str]:
    """Lists all available versions for a specific agent runtime.

    Args:
        agentRuntimeId (str): The unique identifier of the agent runtime

    Returns:
        list[str]: List of agent runtime version strings
    """
    return _explore_agent_property(
        agentRuntimeId,
        "agentRuntimeVersion",
        BAC_CLIENT.list_agent_runtime_versions,
        root_key="agentRuntimes",
    )


@app.resolver(type_name="Query", field_name="listAgentEndpoints")
def list_agent_endpoints(agentRuntimeId: str) -> list[str]:
    """Lists all endpoint names for a specific agent runtime.

    Args:
        agentRuntimeId (str): The unique identifier of the agent runtime

    Returns:
        list[str]: List of endpoint names
    """
    return _explore_agent_property(
        agentRuntimeId,
        "name",
        BAC_CLIENT.list_agent_runtime_endpoints,
        root_key="runtimeEndpoints",
    )


@app.resolver(type_name="Mutation", field_name="deleteAgentRuntime")
def delete_agent_runtime(agentName: str, agentRuntimeId: str) -> str:
    state_machine_arn = os.environ["DELETE_RUNTIME_STATE_MACHINE_ARN"]

    try:
        SFN_CLIENT.start_execution(
            stateMachineArn=state_machine_arn,
            input=json.dumps(
                {
                    "agentName": agentName,
                    "agentRuntimeId": agentRuntimeId,
                }
            ),
        )
        logger.info(
            f"Started Step Function execution for deleting runtime of agent {agentName}"
        )
        return agentRuntimeId
    except ClientError as err:
        logger.error(
            "Failed to start Step Function execution",
            extra={"rawErrorMessage": str(err)},
        )
        return ""


@app.resolver(type_name="Mutation", field_name="deleteAgentRuntimeEndpoints")
def delete_agent_runtime_endpoint(
    agentName: str, agentRuntimeId: str, endpointNames: list[str]
) -> str:
    state_machine_arn = os.environ["DELETE_ENDPOINTS_STATE_MACHINE_ARN"]

    try:
        SFN_CLIENT.start_execution(
            stateMachineArn=state_machine_arn,
            input=json.dumps(
                {
                    "agentName": agentName,
                    "agentRuntimeId": agentRuntimeId,
                    "endpoints": endpointNames,
                }
            ),
        )
        logger.info(
            f"Started Step Function execution for deleting endpoints {endpointNames}"
        )
        return agentRuntimeId
    except ClientError as err:
        logger.error(
            "Failed to start Step Function execution",
            extra={"rawErrorMessage": str(err)},
        )
        return ""


# Helpers
def _get_runtime_cfg_by_qualifier_impl(agentName: str, qualifier: str) -> str:
    try:
        response = SUMMARY_TABLE.query(
            KeyConditionExpression="AgentName = :agent",
            ExpressionAttributeValues={":agent": agentName},
        )
        items = response.get("Items", [])
        if not items:
            logger.error(f"Agent {agentName} not found")
            return ""
        qualifier_to_version = items[0].get("QualifierToVersion", {})

        logger.info(
            "Retrieved object that map qualifiers to versions",
            extra={"qualifierToVersion": qualifier_to_version},
        )

        if qualifier not in qualifier_to_version:
            logger.error(f"Agent {agentName} has no qualifier {qualifier}")
            return ""

        response = TABLE.query(
            IndexName="byAgentNameAndVersion",
            KeyConditionExpression=Key("AgentName").eq(agentName)
            & Key("AgentRuntimeVersion").eq(str(qualifier_to_version[qualifier])),
        )
        items = response.get("Items", [])
        return items[0].get("ConfigurationValue", "") if items else ""
    except ClientError as err:
        logger.error(
            "Failed to query runtime configuration", extra={"rawErrorMessage": str(err)}
        )
        logger.exception(err)
        return ""


def _explore_agent_property(
    runtime_id: str, prop_name: str, func: Callable, root_key: str
) -> list[str]:
    props = []
    try:
        response = func(agentRuntimeId=runtime_id, maxResults=100)
        props.extend(
            [
                elem.get(prop_name, "")
                for elem in response.get(root_key, [])
                if elem.get("status", "") == "READY"
            ]
        )

        while response.get("nextToken"):
            response = func(
                agentRuntimeId=runtime_id,
                maxResults=100,
                nextToken=response.get("nextToken"),
            )
            props.extend(
                [
                    elem.get(prop_name, "")
                    for elem in response.get(root_key, [])
                    if elem.get("status", "") == "READY"
                ]
            )

    except ClientError as err:
        logger.error(
            "Failed to retrieve agent properties", extra={"rawErrorMessage": str(err)}
        )
        return []
    return props


class OperationInProgress(Exception):
    """Custom exception used to raise in retry function if operation hasn't reached a final state"""

    ...


@retry(OperationInProgress, delay=0.5, tries=58)
def _check_on_endpoint_creation(runtime_id: str, qualifier: str) -> str:
    """Check on runtime endpoint creation"""
    response = BAC_CLIENT.get_agent_runtime_endpoint(
        agentRuntimeId=runtime_id, endpointName=qualifier
    )
    status = response.get("status")
    if status in ("CREATING", "UPDATING", "DELETING"):
        logger.info(f"Waiting for endpoint {qualifier} to be ready...")
        raise OperationInProgress
    return status


# Handler
@logger.inject_lambda_context(correlation_id_path=correlation_paths.APPSYNC_RESOLVER)
def handler(event: dict, context: LambdaContext):
    return app.resolve(event, context)
