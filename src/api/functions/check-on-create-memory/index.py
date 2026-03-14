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
tracer = Tracer(service="graphQL-checkOnExistMemory")
logger = Logger(service="graphQL-checkOnExistMemory")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    memoryId: str


class Body(BaseModel):
    message: str
    status: str


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Check creation status of an AgentCore Memory.

    Args:
        event: InputModel containing agentRuntimeId and endpoint name
        _: Lambda context (unused)

    Returns:
        dict: Response with status code and message
    """
    try:
        response = BAC_CLIENT.get_memory(memoryId=event.memoryId)
        memory_props = response.get("memory", {})
        logger.info(
            "Get AgentCore Memory returned a response",
            extra={"memoryProps": memory_props},
        )
        msg = f"Got the status of memory {event.memoryId}"
        output = OutputModel(
            status=200,
            body=Body(message=msg, status=memory_props.get("status", "")),
        )
    except ClientError as err:
        msg = "Failed to fetch properties of the AgentCore Memory instance"
        logger.error(msg, extra={"rawErrorMessage": str(err)})
        output = OutputModel(status=400, body=Body(message=msg, status="FAILED"))

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )

    return output.model_dump()
