# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from typing import Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="graphQL-listAgentRuntimeEndpoints")
logger = Logger(service="graphQL-listAgentRuntimeEndpoints")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")


# ---------------------------------------------------------- #
class InputModel(BaseModel):
    agentRuntimeId: str


class Body(BaseModel):
    endpoints: Optional[list[str]] = None
    msg: Optional[str] = None


class OutputModel(BaseModel):
    status: int
    body: Body


DEFAULT_ENDPOINT_ID = "DEFAULT"


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """List the endpoints associated with a Bedrock AgentCore runtime.

    Args:
        event: InputModel containing agentRuntimeId
        _: Lambda context (unused)

    Returns:
        dict: Response with status code and endpoint names
    """
    endpoints = []
    max_results = 20
    try:
        response = BAC_CLIENT.list_agent_runtime_endpoints(
            agentRuntimeId=event.agentRuntimeId, maxResults=max_results
        )
        endpoints.extend(
            [
                elem.get("name", "")
                for elem in response.get("runtimeEndpoints", [])
                if elem.get("status", "") == "READY"
                and elem.get("name") != DEFAULT_ENDPOINT_ID
            ]
        )
        while response.get("nextToken"):
            response = BAC_CLIENT.list_agent_runtime_endpoints(
                agentRuntimeId=event.agentRuntimeId,
                maxResults=max_results,
                nextToken=response.get("nextToken"),
            )
            endpoints.extend(
                [
                    elem.get("name", "")
                    for elem in response.get("runtimeEndpoints", [])
                    if elem.get("status", "") == "READY"
                    and elem.get("name") != DEFAULT_ENDPOINT_ID
                ]
            )
        output = OutputModel(status=200, body=Body(endpoints=endpoints))
    except ClientError as err:
        msg = "Failed to retrieve agent endpoints"
        logger.error(msg, extra={"rawErrorMessage": str(err)})
        output = OutputModel(status=400, body=Body(msg=msg))

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )
    return output.model_dump(exclude_none=True)
