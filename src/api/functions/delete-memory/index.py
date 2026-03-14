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
tracer = Tracer(service="graphQL-deleteAgentCoreMemory")
logger = Logger(service="graphQL-deleteAgentCoreMemory")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    memoryId: str


class Body(BaseModel):
    message: str


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Delete a Bedrock AgentCore Memory.

    Args:
        event: InputModel containing agentRuntimeId
        _: Lambda context (unused)

    Returns:
        dict: Response with status code and message
    """
    try:
        response = BAC_CLIENT.delete_memory(memoryId=event.memoryId)
        logger.info(
            "AgentCore memory deletion returned a response",
            extra={"apiResponse": response},
        )
        msg = f"Initialized deletion of AgentCore memory {event.memoryId}"
        logger.info(msg)
        output = OutputModel(status=200, body=Body(message=msg))
    except ClientError as err:
        msg = "Failed to delete memory"
        output = OutputModel(status=400, body=Body(message=msg))
        logger.error(msg, extra={"rawErrorMessage": str(err)})

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )
    return output.model_dump()
