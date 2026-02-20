# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="deleteAgentVersions")
logger = Logger(service="deleteAgentVersions")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
DYNAMODB = boto3.resource("dynamodb")
VERSIONS_TABLE_NAME = os.environ["VERSIONS_TABLE_NAME"]
VERSIONS_TABLE = DYNAMODB.Table(VERSIONS_TABLE_NAME)  # type: ignore
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentName: str


class Body(BaseModel):
    message: str
    deletedCount: int = 0


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Delete all version items for a given AgentName from DynamoDB.

    This function queries the versions table for all items with the specified
    AgentName (partition key) and deletes them in batches.

    Args:
        event: InputModel containing agentName
        _: Lambda context (unused)

    Returns:
        dict: Response with status code, message, and count of deleted items
    """
    try:
        # Query all items with the specified AgentName
        response = VERSIONS_TABLE.query(
            KeyConditionExpression="AgentName = :agent_name",
            ExpressionAttributeValues={":agent_name": event.agentName},
            ProjectionExpression="AgentName, CreatedAt",
        )

        items = response.get("Items", [])
        deleted_count = 0

        # Handle pagination if there are more items
        while "LastEvaluatedKey" in response:
            response = VERSIONS_TABLE.query(
                KeyConditionExpression="AgentName = :agent_name",
                ExpressionAttributeValues={":agent_name": event.agentName},
                ProjectionExpression="AgentName, CreatedAt",
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))

        logger.info(
            f"Found {len(items)} version items to delete for agent {event.agentName}"
        )

        # Batch delete items (DynamoDB allows up to 25 items per batch)
        if items:
            with VERSIONS_TABLE.batch_writer() as batch:
                for item in items:
                    batch.delete_item(
                        Key={
                            "AgentName": item["AgentName"],
                            "CreatedAt": item["CreatedAt"],
                        }
                    )
                    deleted_count += 1

        msg = f"Successfully deleted {deleted_count} version items for agent {event.agentName}"
        logger.info(msg)
        output = OutputModel(
            status=200, body=Body(message=msg, deletedCount=deleted_count)
        )

    except ClientError as err:
        msg = f"Failed to delete version items for agent {event.agentName}"
        output = OutputModel(status=400, body=Body(message=msg))
        logger.error(msg, extra={"rawErrorMessage": str(err)})
    except Exception as err:
        msg = f"Unexpected error deleting version items for agent {event.agentName}"
        output = OutputModel(status=500, body=Body(message=msg))
        logger.error(msg, extra={"rawErrorMessage": str(err)})

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )
    return output.model_dump()
