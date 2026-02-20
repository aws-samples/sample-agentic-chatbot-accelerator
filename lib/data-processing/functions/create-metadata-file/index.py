# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
import json
import os
from decimal import Decimal
from pathlib import Path
from typing import Mapping

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError
from genai_core.data.dynamo import DocumentStore
from genai_core.exceptions import AcaException

# ------------------------- Environment Variables ------------------------ #
TABLE_NAME = os.environ.get("TABLE_NAME", "todo")
# ------------------------------------------------------------------------ #

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-dataProcessing-createMetadataFile")
tracer = Tracer(service="aca-dataProcessing-createMetadataFile")
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
S3_RESOURCE = boto3.resource("s3")
# -------------------------------------------------------------------- #


class InputModel(BaseModel):
    """Input model for the Lambda function that creates a metadata file in S3.

    Attributes:
        bucket (str): S3 bucket where the document is stored
        key (str): S3 key of the document
        documentId (str): Unique identifier for the document
        extension (str): File extension of the document
        prefixDataSource (str): KnowledgeBase DataSource prefix
    """

    bucket: str
    key: str
    documentId: str
    extension: str
    prefixDataSource: str


class OutputModel(BaseModel):
    """Output model for the Lambda function that creates a metadata file in S3.

    Attributes:
        documentId (str): Unique identifier for the document
        bucket (str): S3 bucket where metadata file is stored
        metadataKey (str): S3 key of the metadata file
    """

    documentId: str
    bucket: str
    metadataKey: str


class Encoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return str(obj)
        return super(Encoder, self).default(obj)


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> Mapping:
    """Lambda function handler that creates a metadata file associated with a document belonging to an S3 Knowledge Base data source.

    Args:
        event (InputModel): See `InputModel`
        _ : Context object (unused)

    Returns:
        Mapping: Response containing status code and output model (see `OutputModel`) as body if successful, and error message otherwise

    Raises:
        AcaException: If there is an error retrieving document from DynamoDB
        ClientError: If there is an error uploading metadata file to S3
    """
    logger.info(
        f"Initializing creation of the metadata associated with the document {event.documentId}"
    )

    logger.info(f"Connecting document store to table {TABLE_NAME}")
    try:
        doc_store = DocumentStore(table_name=TABLE_NAME, logger=logger)
        record = doc_store.get_document(event.documentId)
        if record is None:
            raise AcaException(
                f"The document {event.documentId} is not part of the dynamoDB table"
            )
    except AcaException as err:
        logger.exception(err)
        return {
            "statusCode": 400,
            "body": str(err),
        }

    doc_metadata = record.get("Metadata", {})
    if not doc_metadata:
        logger.info(
            f"The document {event.documentId} has not any metadata associated with it"
        )
    else:
        logger.info(
            f"Metadata associated with {event.documentId}: {json.dumps(doc_metadata, default=str)}"
        )

    indexed_key = f"{event.prefixDataSource}/{event.documentId}{event.extension}"
    logger.info(f"Indexed key {indexed_key}")
    parts = Path(event.key).parts
    if len(parts) > 0:
        metadata_file_content = {
            "metadataAttributes": {
                "documentName": "/".join(parts[1:]) if len(parts) > 1 else parts[0],
                **doc_metadata,
            }
        }
    else:
        metadata_file_content = {}
    metadata_key = f"{indexed_key}.metadata.json"
    s3_object = S3_RESOURCE.Object(event.bucket, metadata_key)  # type: ignore # this is correct is just that pylint cannot access boto3 resources
    try:
        s3_object.put(
            Body=(
                bytes(json.dumps(metadata_file_content, cls=Encoder).encode("UTF-8"))
            ),
            ContentType="application/json",
        )
    except ClientError as err:
        logger.exception(err)
        return {
            "statusCode": 400,
            "body": str(err),
        }

    response_body = OutputModel(
        documentId=event.documentId,
        bucket=event.bucket,
        metadataKey=metadata_key,
    )
    return {
        "statusCode": 200,
        "body": response_body.model_dump(),
    }
