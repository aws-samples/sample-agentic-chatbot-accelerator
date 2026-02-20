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
tracer = Tracer(service="graphQL-checkOnCreateRuntime")
logger = Logger(service="graphQL-checkOnCreateRuntime")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")


# ---------------------------------------------------------- #
class InputModel(BaseModel):
    agentRuntimeId: str
    agentRuntimeVersion: str


class Body(BaseModel):
    message: str
    status: str


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Check the status of an AgentCore Runtime during creation.

    Args:
        event (InputModel): The parsed input event containing:
            - agentRuntimeId (str): The unique identifier of the agent runtime
            - agentRuntimeVersion (str): The version of the agent runtime to check
        _ (LambdaContext): AWS Lambda context object (unused)

    Returns:
        dict: A dictionary containing:
            - status (int): HTTP status code (200 for success, 400 for failure)
            - body (dict): Response body with:
                - message (str): Descriptive message about the operation
                - status (str): The current status of the agent runtime (e.g., CREATING, ACTIVE, FAILED)

    Raises:
        ClientError: If the Bedrock AgentCore API call fails, the exception is caught
                     and transformed into a 400 error response
    """
    try:
        response = BAC_CLIENT.get_agent_runtime(
            agentRuntimeId=event.agentRuntimeId,
            agentRuntimeVersion=event.agentRuntimeVersion,
        )
        logger.info(
            "Get AgentCore Runtime returned a response",
            extra={"apiResponse": response},
        )
        msg = f"Got the status of runtime {event.agentRuntimeId}"
        output = OutputModel(
            status=200,
            body=Body(message=msg, status=response.get("status", "")),
        )
    except ClientError as err:
        msg = "Failed to fetch AgentCore Runtime status"
        logger.error(msg, extra={"rawErrorMessage": str(err)})
        output = OutputModel(status=400, body=Body(message=msg, status="FAILED"))

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )

    return output.model_dump()
