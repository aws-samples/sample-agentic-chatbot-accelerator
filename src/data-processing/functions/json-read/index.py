# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
import json

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-dataProcessing-readJson")
tracer = Tracer(service="aca-dataProcessing-readJson")
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
S3_CLIENT = boto3.client("s3")
# -------------------------------------------------------------------- #


class InputModel(BaseModel):
    """Input model for the Lambda function that extracts transcript
        from Amazon Transcribe output json.

    Attributes:
        bucket (str): Name of the S3 bucket containing the document
        keyIn (str): Input object key/path of the document in the S3 bucket
        keyOut (str): Output object key/path of the document in the S3 bucket
    """

    bucket: str
    keyIn: str
    keyOut: str


class OutputModel(BaseModel):
    """Input model for the Lambda function that extracts transcript
        from Amazon Transcribe output json.

    Attributes:
        metadata (dict): Extracted metadata
    """

    metadata: dict[str, str | int | float | bool | None] | None


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _):
    """Lambda function that extracts text and metadata from json.

    Args:
        event (InputModel): Event containing bucket, keyIn and keyOut
        _ : Unused context parameter

    Returns:
        dict: Dictionary containing statusCode and OutputModel body with metadata
    """
    logger.info(f"Bucket that contains the document: {event.bucket}")
    logger.info(f"Document key in: {event.keyIn}")
    logger.info(f"Document key out: {event.keyOut}")

    file_object = S3_CLIENT.get_object(Bucket=event.bucket, Key=event.keyIn)
    file_json = json.loads(file_object.get("Body").read().decode("utf-8"))
    file_str = file_json["text"]
    file_metadata = file_json.get("metadata", {})

    S3_CLIENT.put_object(
        Body=file_str,
        Bucket=event.bucket,
        Key=event.keyOut,
        ContentType="text/plain",
    )

    response_body = OutputModel(metadata=file_metadata)

    return {
        "statusCode": 200,
        "body": response_body.model_dump(),
    }
