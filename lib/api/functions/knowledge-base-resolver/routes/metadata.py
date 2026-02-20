# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import os
from typing import Mapping

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from botocore.exceptions import ClientError
from genai_core.api_helper.auth import fetch_user_id
from genai_core.api_helper.types import StatusResponse
from genai_core.data.s3 import load_json, upload_json

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-knowledgeBasesRoute")
# -------------------------------------------------------------------- #

# ---------------------- AWS CLIENTS/RESOURCES ----------------------- #
DYNAMO_DB_RESOURCE = boto3.resource("dynamodb")
S3_CLIENT = boto3.client("s3")
# -------------------------------------------------------------------- #

# ------------------------- Environment Variables ------------------------ #
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION")
AWS_ACCOUNT = boto3.client("sts").get_caller_identity().get("Account")
ENV_PREFIX = os.environ.get("ENV_PREFIX")
DOCUMENT_TABLE_NAME = os.environ.get("DOCUMENT_TABLE_NAME")
DATA_BUCKET_ARN = os.environ["DATA_BUCKET_ARN"]
# ------------------------------------------------------------------------ #


@router.resolver(field_name="getDocumentMetadata")
@tracer.capture_method
@fetch_user_id(router)
def get_document_metadata(user_id: str, documentId: str) -> str:
    """
    Retrieves metadata associated with a specific document.

    Args:
        user_id (str): ID of the user requesting the metadata
        documentId (str): ID of the document to retrieve metadata for

    Returns:
        str: JSON string containing the document's metadata attributes

    Raises:
        KeyError: If metadata attributes are missing
        ClientError: If there are AWS service errors
        ValueError: If metadata cannot be parsed
    """
    logger.info(
        f"User {user_id} is asking for metadata associated with document {documentId}"
    )
    table = DYNAMO_DB_RESOURCE.Table(DOCUMENT_TABLE_NAME)  # type: ignore

    try:
        s3_uri_metadata_file = _get_metadata_uri(table, documentId)

        logger.info(f"Metadata located at: {s3_uri_metadata_file}")
        metadata_file_content = load_json(s3_uri_metadata_file, S3_CLIENT)
        metadata_attributes = metadata_file_content["metadataAttributes"]  # type: ignore
        logger.info("Metadata successfully retrieved")

    except (KeyError, ClientError, ValueError) as err:
        logger.error(f"Failed to fetch attributes of document {documentId}")
        logger.exception(err)
        raise err

    logger.info(metadata_attributes)

    return json.dumps(metadata_attributes)


@router.resolver(field_name="updateMetadata")
@tracer.capture_method
@fetch_user_id(router)
def update_document_metadata(user_id: str, documentId: str, metadata: str) -> Mapping:
    """
    Updates metadata for a specific document in both S3 and DynamoDB.

    Args:
        user_id (str): ID of the user requesting the metadata update
        documentId (str): ID of the document to update metadata for
        metadata (str): JSON string containing the new metadata values

    Returns:
        bool: True if update was successful, False otherwise

    Raises:
        json.JSONDecodeError: If metadata string cannot be parsed as JSON
        ClientError: If there are AWS service errors accessing S3 or DynamoDB
    """
    logger.info(
        f"User {user_id} wants to update metadata associated with document {documentId}"
    )
    table = DYNAMO_DB_RESOURCE.Table(DOCUMENT_TABLE_NAME)  # type: ignore
    try:
        parsed_metadata = json.loads(metadata)
    except json.JSONDecodeError:
        return {"status": StatusResponse.INVALID_CONFIG.value}

    return _update_metadata_implementation(table, documentId, parsed_metadata)


@router.resolver(field_name="batchUpdateMetadata")
@tracer.capture_method
@fetch_user_id(router)
def batch_update_metadata(user_id: str, metadataFile: str) -> Mapping:
    """
    Batch updates metadata for multiple documents using a JSONL file.

    Args:
        user_id (str): ID of the user requesting the batch metadata update
        metadataFile (str): Name of the JSONL file containing metadata updates

    Returns:
        Mapping: Dictionary containing:
            - id: URI of the metadata file processed
            - status: Status of the batch update operation (SUCCESSFUL, INVALID_NAME, INVALID_CONFIG)

    Raises:
        ClientError: If there are AWS service errors accessing S3 or DynamoDB
        json.JSONDecodeError: If JSONL file cannot be parsed
        KeyError: If required fields are missing in JSONL entries

    Notes:
        The JSONL file should contain one JSON object per line with:
        - documentId: ID of document to update
        - metadata: Object containing metadata key-value pairs
    """
    logger.info(
        f"User {user_id} is updating metadata with information from {metadataFile}"
    )
    if not metadataFile.lower().endswith(".jsonl"):
        return {
            "id": metadataFile,
            "status": StatusResponse.INVALID_NAME.value,
        }
    bucket_name = DATA_BUCKET_ARN.split(":")[-1]
    metadata_uri = f"s3://{bucket_name}/{metadataFile}"
    logger.info(f"Metadata located at: {metadata_uri}")

    parsed_items = _parse_metadata_from_jsonl(metadata_uri)
    if not parsed_items:
        return {
            "id": metadata_uri,
            "status": StatusResponse.INVALID_CONFIG.value,
        }

    table = DYNAMO_DB_RESOURCE.Table(DOCUMENT_TABLE_NAME)  # type: ignore

    for elem in parsed_items:
        res = _update_metadata_implementation(
            table,
            elem[0],
            elem[1],
        )
        if res["status"] != StatusResponse.SUCCESSFUL.value:
            logger.warning(f"Failed to update metadata for document {elem[0]}")

    return {
        "id": metadata_uri,
        "status": StatusResponse.SUCCESSFUL.value,
    }


### Helpers ###


def _get_metadata_uri(table, documentId: str) -> str:
    """Constructs and returns the S3 URI for a document's metadata file."""
    response = table.get_item(Key={"DocumentId": documentId})
    attributes = response["Item"]
    logger.info("Fetched attributes from document table")

    return f"s3://{attributes['BucketName']}/{attributes['DataSourcePrefix']}/{documentId}{attributes['Extension']}.metadata.json"


def _update_metadata_implementation(
    table, doc_id: str, metadata_values: Mapping
) -> Mapping:
    """Updates metadata for a document in both S3 and DynamoDB."""
    try:
        logger.info("New metadata values")
        logger.info(metadata_values)

        s3_uri_metadata_file = _get_metadata_uri(table, doc_id)
        parts = s3_uri_metadata_file.replace("s3://", "").split("/")
        fmt_metadata = {
            "metadataAttributes": metadata_values,
        }
        upload_json(S3_CLIENT, fmt_metadata, parts[0], "/".join(parts[1:]))
        logger.info("Updated metadata JSON file")

        table.update_item(
            Key={"DocumentId": doc_id},
            UpdateExpression="SET Metadata = :metadata",
            ExpressionAttributeValues={":metadata": metadata_values},
        )
        logger.info("Updated table with metadata")

    except ClientError as err:
        logger.error("Failed to update the metadata file")
        logger.exception(err)
        return {"status": StatusResponse.SERVICE_ERROR.value}

    return {
        "id": doc_id,
        "status": StatusResponse.SUCCESSFUL.value,
    }


def _parse_metadata_from_jsonl(metadata_obj_uri: str):
    """Parses a JSONL file from S3 containing document metadata and returns a list of (documentId, metadata) tuples."""
    results = []

    parts = metadata_obj_uri.replace("s3://", "").split("/")
    logger.info(parts)

    obj_bucket = parts[0]
    logger.info(f"Bucket: {obj_bucket}")
    obj_key = "/".join(parts[1:])
    logger.info(f"Object key: {obj_key}")

    try:
        response = S3_CLIENT.get_object(Bucket=obj_bucket, Key=obj_key)

        content = response["Body"].read().decode("utf-8")

        for line in content.splitlines():
            if line.strip():
                data = json.loads(line)
                results.append((data["documentId"], data["metadata"]))

    except (ClientError, json.JSONDecodeError, KeyError) as err:
        logger.error("Unable to read JSONL file with metadata")
        logger.exception(err)
        results = []

    return results
