# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import (
    SQSEvent,
    event_source,
)
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.parser import BaseModel, parse
from aws_lambda_powertools.utilities.typing import LambdaContext
from genai_core.processing.types import (
    BEDROCK_KB_SUPPORTED_OFFICE_EXTENSIONS,
    VIDEO_EXTENSIONS,
)
from genai_core.processing.utils import generate_doc_hash

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-dataProcessing-startPipeline")
tracer = Tracer(service="aca-dataProcessing-startPipeline")
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
SFN_CLIENT = boto3.client("stepfunctions")
# -------------------------------------------------------------------- #

# ------------------------- Environment Variables ------------------------ #
STATE_MACHINE_ARN = os.environ.get("STATE_MACHINE_ARN", "my-state-machine")
# ------------------------------------------------------------------------ #

# ------------------------- Global Variables ------------------------ #
DOCUMENT_TYPE_MAPPING = {
    **dict.fromkeys(VIDEO_EXTENSIONS, "VIDEO"),
    **dict.fromkeys(BEDROCK_KB_SUPPORTED_OFFICE_EXTENSIONS, "KB_OFFICE"),
    ".txt": "TEXT",
    ".md": "MARKDOWN",
    ".html": "HTML",
    ".csv": "CSV",
    ".pdf": "PDF",
    ".json": "JSON",
}
# -------------------------------------------------------------------- #


class OutputModel(BaseModel):
    """Output model for the Lambda function that add launches a state machine to process the request.

    Attributes:
        documentId (str): Unique identifier for the document
        documentType (str): Type of document (e.g. VIDEO, PDF, TEXT etc)
        documentExtension (str): File extension of the document (e.g. .pdf, .txt)
        objectName (str): Object name, generated from object key discarding prefixes
        s3RequestTimestamp (str): Timestamp of the S3 notification event
        bucket (str): document bucket
        key (str): document key
        processedOn (str): DateTime of request processing start
        etag: (str): Document content hash
        detailType (str): Request type

        prefixInput (str): S3 document input prefix
        prefixDataSource (str): S3 prefix for the knowledge base data source,
        prefixProcessing (str): S3 prefix for the processing steps,
        midfixStaging (str): S3 midfix for staging documents for processing,
        midfixTranscribe (str): S3 midfix for transcribe step,
        transcribeJobPrefix (str): Transcribe job prefix,
        stackName (str): Stack name,
        languageCode (str): Language code (e.g. for transcribe),

    """

    documentId: str
    documentType: str
    documentExtension: str
    objectName: str
    s3RequestTimestamp: str
    bucket: str
    key: str
    processedOn: str
    etag: str
    detailType: str

    prefixInput: str
    prefixDataSource: str
    prefixProcessing: str
    midfixStaging: str
    midfixTranscribe: str
    transcribeJobPrefix: str
    stackName: str
    languageCode: str


@tracer.capture_method
def extract_object_name(object_key, prefix):
    pattern = f"^{re.escape(prefix)}/(.+)$"
    match = re.search(pattern, object_key)
    if match:
        return match.group(1)
    else:
        raise AssertionError(
            f"Object key '{object_key}' should match expected pattern with prefix '{prefix}' by state machine design"
        )


class InputModel(BaseModel):
    """Input model for the Lambda function that add launches a state machine to process the request.

    Attributes:
        bucket (str): Name of the S3 bucket containing the document
        key (str): S3 object key
        s3RequestTimestamp (str): S3 request timestamp
        etag: (str): Document content hash
        detailType (str): Request type

        prefixInput (str): S3 document input prefix
        prefixDataSource (str): S3 prefix for the knowledge base data source,
        prefixProcessing (str): S3 prefix for the processing steps,
        midfixStaging (str): S3 midfix for staging documents for processing,
        midfixTranscribe (str): S3 midfix for transcribe step,
        transcribeJobPrefix (str): Transcribe job prefix,
        stackName (str): Stack name,
        languageCode (str): Language code (e.g. for transcribe),
    """

    bucket: str
    key: str
    s3RequestTimestamp: str
    etag: str
    detailType: str

    prefixInput: str
    prefixDataSource: str
    prefixProcessing: str
    midfixStaging: str
    midfixTranscribe: str
    transcribeJobPrefix: str
    stackName: str
    languageCode: str


@tracer.capture_method
def process_record(record: SQSRecord) -> OutputModel:
    """Extract document location information from an S3 event record.

    Args:
        record (SQSRecord): SQS message containing document information

    Returns:
        OutputModel: Dictionary containing record information
    """

    payload = parse(record.json_body, InputModel)
    logger.info(payload)

    logger.info(f"Bucket that contains the document: {payload.bucket}")
    logger.info(f"Document key: {payload.key}")

    extension = Path(payload.key).suffix
    document_type = DOCUMENT_TYPE_MAPPING.get(extension, "UNKNOWN")
    logger.info(f"Document type is {document_type}")
    document_id = generate_doc_hash(payload.key, 0)
    logger.info(f"Document ID is {document_id}")
    object_name = extract_object_name(payload.key, payload.prefixInput)
    logger.info(f"Object name is {object_name}")

    return OutputModel(
        documentId=document_id,
        documentType=document_type,
        documentExtension=extension,
        objectName=object_name,
        s3RequestTimestamp=payload.s3RequestTimestamp,
        key=payload.key,
        bucket=payload.bucket,
        processedOn=str(datetime.now(timezone.utc)),
        etag=payload.etag,
        detailType=payload.detailType,
        prefixInput=payload.prefixInput,
        prefixDataSource=payload.prefixDataSource,
        prefixProcessing=payload.prefixProcessing,
        midfixStaging=payload.midfixStaging,
        midfixTranscribe=payload.midfixTranscribe,
        transcribeJobPrefix=payload.transcribeJobPrefix,
        stackName=payload.stackName,
        languageCode=payload.languageCode,
    )


@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
@event_source(data_class=SQSEvent)
def handler(event: SQSEvent, _: LambdaContext):
    """Process S3 events and start step function executions for document processing.

    Args:
        event (S3Event): The S3 event containing records of uploaded files
        _ (LambdaContext): Lambda context object (unused)

    Returns:
        Dict[str, Any]: Response object containing:
            - statusCode (int): HTTP status code (200)
            - headers (Dict): Response headers with Content-Type
            - body (str): Message indicating number of documents processed
    """
    messages = event.raw_event["Records"]
    logger.info(f"Messages received: {len(messages)}")

    documents = [process_record(record=SQSRecord(record)) for record in messages]
    documents = [
        doc for doc in documents if doc.key[-1] != "/"
    ]  # filter out folders objects

    logger.info(f"document_locations: {documents}")

    if documents:
        logger.info(
            f"Starting step function for a batch of {len(documents)} documents."
        )

        SFN_CLIENT.start_execution(
            stateMachineArn=STATE_MACHINE_ARN,
            input=json.dumps([d.model_dump() for d in documents]),
        )

        body_returned = f"Number of documents started: {len(documents)}"
    else:
        logger.info("No document detected")
        body_returned = "No document detected"

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "text/plain"},
        "body": body_returned,
    }
