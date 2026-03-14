# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
import json
from datetime import datetime

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-dataProcessing-readTranscribe")
tracer = Tracer(service="aca-dataProcessing-readTranscribe")
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
        timestamp (str): Timestamp of completion
    """

    timestamp: str


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _):
    """Lambda function that extracts transcript from Amazon Transcribe output json.

    Args:
        event (InputModel): Event containing bucket, key and execution ID
        _ : Unused context parameter

    Returns:
        OutputModel
    """
    logger.info(f"Bucket that contains the document: {event.bucket}")
    logger.info(f"Document key in: {event.keyIn}")
    logger.info(f"Document key out: {event.keyOut}")

    transcript_file_object = S3_CLIENT.get_object(Bucket=event.bucket, Key=event.keyIn)
    transcript_json = json.loads(
        transcript_file_object.get("Body").read().decode("utf-8")
    )
    transcript_str = transcript_json["results"]["transcripts"][0]["transcript"]

    S3_CLIENT.put_object(
        Body=transcript_str,
        Bucket=event.bucket,
        Key=event.keyOut,
        ContentType="text/plain",
    )

    response_body = OutputModel(timestamp=datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))

    return {
        "statusCode": 200,
        "body": response_body.model_dump(),
    }
