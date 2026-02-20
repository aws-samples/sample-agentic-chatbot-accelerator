# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
import os

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.batch import (
    BatchProcessor,
    EventType,
    process_partial_response,
)
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.parser import BaseModel, parse
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-knowledgeBase-sync")
tracer = Tracer(service="aca-knowledgeBase-sync")
processor = BatchProcessor(event_type=EventType.SQS)
# -------------------------------------------------------------------- #

# ------------------------- Environment Variables ------------------------ #
KNOWLEDGEBASE_TABLE_NAME = os.environ.get("KNOWLEDGEBASE_TABLE_NAME", "Table???")
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
bedrock_agent = boto3.client("bedrock-agent")
dynamodb = boto3.resource("dynamodb")
KNOWLEDGEBASE_TABLE = dynamodb.Table(KNOWLEDGEBASE_TABLE_NAME)
# -------------------------------------------------------------------- #


@tracer.capture_method
def process_request(
    knowledgeBaseId: str,
    dataSourceId: str,
    s3RequestTimestamp: str,
    key: str,
) -> None:
    """
    Process sync request

    Args:
        knowledgeBaseId (str): KnowledgeBase ID to sync
        dataSourceId (str): DataSource ID to sync
        s3RequestTimestamp (str): Timestamp of the S3 request
        key (str): S3 key of the triggering document
    """

    if key[-1] == "/":
        return

    # check if request is not expired
    try:
        KNOWLEDGEBASE_TABLE.update_item(
            Key={
                "KnowledgeBaseId": knowledgeBaseId,
                "DataSourceId": dataSourceId,
            },
            UpdateExpression="SET S3RequestTimestamp = :s3RequestTimestampValue",
            ExpressionAttributeValues={":s3RequestTimestampValue": s3RequestTimestamp},
            ConditionExpression="(attribute_not_exists(S3RequestTimestamp) OR  S3RequestTimestamp <= :s3RequestTimestampValue)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info(f"Expired request for document: {key}")
            return
        else:
            logger.error(f"DynamoDB error for message {key}: {str(e)}")
            raise

    try:
        # Start the ingestion job
        response = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=knowledgeBaseId,
            dataSourceId=dataSourceId,
        )

        ingestion_job_id = response["ingestionJob"]["ingestionJobId"]
        ingestion_job_start_time = response["ingestionJob"]["startedAt"].strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        logger.info(
            f"Ingestion job started at {ingestion_job_start_time}. Job ID: {ingestion_job_id}"
        )

    except Exception as e:
        logger.error(f"Failed to start ingestion job for key {key}: {str(e)}")
        raise

    # update S3RequestTimestamp with the ingestion job start time
    try:
        KNOWLEDGEBASE_TABLE.update_item(
            Key={
                "KnowledgeBaseId": knowledgeBaseId,
                "DataSourceId": dataSourceId,
            },
            UpdateExpression="SET S3RequestTimestamp = :s3RequestTimestampValue",
            ExpressionAttributeValues={  # Fixed: was ExpressionAttributeNames
                ":s3RequestTimestampValue": ingestion_job_start_time
            },
            ConditionExpression="(attribute_not_exists(S3RequestTimestamp) OR  S3RequestTimestamp <= :s3RequestTimestampValue)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info(f"Expired request for document: {key}")
            return
        else:
            logger.error(f"DynamoDB error for message {key}: {str(e)}")
            return  # no need to trigger an error on this


class InputModel(BaseModel):
    knowledgeBaseId: str
    dataSourceId: str
    s3RequestTimestamp: str
    key: str


@tracer.capture_method
def record_handler(record: SQSRecord) -> None:
    """
    Process an SQS record..

    Args:
        record (SQSRecord): SQS message record containing the sync triggering request metadata

    Returns:
        None
    """
    payload = parse(record.json_body, InputModel)
    logger.info(payload)
    process_request(
        payload.knowledgeBaseId,
        payload.dataSourceId,
        payload.s3RequestTimestamp,
        payload.key,
    )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event, context: LambdaContext) -> None:
    """Lambda handler for processing SQS messages."""
    return process_partial_response(
        event=event,
        record_handler=record_handler,
        processor=processor,
        context=context,
    )
