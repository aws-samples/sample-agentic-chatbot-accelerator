# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="graphQL-deleteAgentRuntimeEndpoint")
logger = Logger(service="graphQL-deleteAgentRuntimeEndpoint")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentRuntimeId: str
    endpoint: str


class Body(BaseModel):
    message: str


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Delete an agent runtime endpoint from Bedrock AgentCore.

    Args:
        event: InputModel containing agentRuntimeId and endpoint name
        _: Lambda context (unused)

    Returns:
        dict: Response with status code and message
    """
    try:
        response = BAC_CLIENT.delete_agent_runtime_endpoint(
            agentRuntimeId=event.agentRuntimeId, endpointName=event.endpoint
        )
        logger.info(
            "AgentCore endpoint deletion returned a response",
            extra={"apiResponse": response},
        )
        msg = f"Initialized deletion of endpoint {event.endpoint} associated with agent {event.agentRuntimeId}"
        logger.info(msg)
        output = OutputModel(status=200, body=Body(message=msg))
    except ClientError as err:
        msg = "Failed to delete agent runtime endpoint"
        output = OutputModel(status=400, body=Body(message=msg))
        logger.error(msg, extra={"rawErrorMessage": str(err)})

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )
    return output.model_dump()
