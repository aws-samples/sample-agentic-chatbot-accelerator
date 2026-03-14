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
tracer = Tracer(service="graphQL-checkOnExistMemory")
logger = Logger(service="graphQL-checkOnExistMemory")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
ENVIRONMENT_TAG = os.environ.get("ENVIRONMENT_TAG", None)
STACK_TAG = os.environ.get("STACK_TAG", None)
PAGE_SIZE = 20
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentName: str


class Body(BaseModel):
    memoryId: Optional[str] = None


class OutputModel(BaseModel):
    status: int
    body: Body


@tracer.capture_method
def list_memories() -> list[str]:
    memory_ids = []
    try:
        response = BAC_CLIENT.list_memories(maxResults=PAGE_SIZE)
        memory_ids.extend(
            [
                elem.get("id", "")
                for elem in response.get("memories", [])
                if elem.get("status", "") == "ACTIVE"
            ]
        )

        while response.get("nextToken"):
            response = BAC_CLIENT.list_memories(
                maxResults=PAGE_SIZE, nextToken=response.get("nextToken")
            )
            memory_ids.extend(
                [
                    elem.get("id", "")
                    for elem in response.get("memories", [])
                    if elem.get("status", "") == "ACTIVE"
                ]
            )

    except ClientError as err:
        logger.error(
            "Failed to retrieve AgentCore Memories", extra={"rawErrorMessage": str(err)}
        )
        return []
    return memory_ids


@tracer.capture_method
def get_memory_arn(memory_id: str) -> str:
    response = BAC_CLIENT.get_memory(memoryId=memory_id)
    return response.get("memory", {}).get("arn", "")


@tracer.capture_method
def tags_match(memory_arn: str) -> bool:
    response = BAC_CLIENT.list_tags_for_resource(resourceArn=memory_arn)

    tags = response.get("tags", {})

    return tags.get("Environment") == ENVIRONMENT_TAG and tags.get("Stack") == STACK_TAG


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Check on existence of AgentCore memory associated with the agent"""
    matching_memory_id = None
    try:
        memory_ids = list_memories()
        logger.info(
            "Retrieved memory ids available in the account",
            extra={"memoryIds": memory_ids},
        )

        matching_memory_id = next(
            (m for m in memory_ids if m.startswith(f"{event.agentName}Memory-")), None
        )

        if matching_memory_id:
            logger.info(f"Found a potential matching memory: {matching_memory_id}")

            memory_arn = get_memory_arn(matching_memory_id)

            if memory_arn and tags_match(memory_arn):
                logger.info("Real match")
            else:
                logger.info("Fake match -- resetting to None")
                matching_memory_id = None

        status_code = 200
    except ClientError as err:
        logger.error("Failed in checking memory", extra={"rawErrorMessage": str(err)})
        status_code = 400

    return OutputModel(
        status=status_code, body=Body(memoryId=matching_memory_id)
    ).model_dump()
