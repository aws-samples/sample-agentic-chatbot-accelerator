# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
from typing import Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="graphQL-createMemory")
logger = Logger(service="graphQL-createMemory")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
ENVIRONMENT_TAG = os.environ.get("ENVIRONMENT_TAG", None)
STACK_TAG = os.environ.get("STACK_TAG", None)
EVENT_EXPIRE_DAYS = int(os.environ.get("EVENT_EXPIRE_DAYS", "90"))
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentName: str


class Body(BaseModel):
    memoryId: Optional[str] = None


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
def handler(event: InputModel, _) -> dict:
    """Start AgentCore memory creation"""
    memory_id = None
    try:
        params = {
            "name": f"{event.agentName}Memory",
            "eventExpiryDuration": EVENT_EXPIRE_DAYS,
            "tags": {"Stack": STACK_TAG},
        }
        if ENVIRONMENT_TAG:
            params["tags"]["Environment"] = ENVIRONMENT_TAG

        response = BAC_CLIENT.create_memory(**params)

        memory_props = response.get("memory", {})
        logger.info(
            "Memory creation successfully started", extra={"memoryProps": memory_props}
        )
        memory_id = memory_props.get("id")
        statusCode = 200
    except ClientError as err:
        logger.error(
            "Failed to start the memory creation process",
            extra={"rawErrorMessage": str(err)},
        )
        raise err

    return OutputModel(status=statusCode, body=Body(memoryId=memory_id)).model_dump()
