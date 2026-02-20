# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import os
from typing import Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from botocore.config import Config
from genai_core.api_helper.auth import fetch_user_id

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-presignedUrlRoute")
# -------------------------------------------------------------------- #

# ----------------------- Environment Variables ---------------------- #
REGION_NAME = os.environ["REGION_NAME"]
EXPIRES_IN_SECONDS = os.environ.get("EXPIRES_IN_SECONDS", 600)
# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
# Use SigV4 for KMS-encrypted S3 objects (required for presigned URLs)
S3_CLIENT = boto3.client("s3", config=Config(signature_version="s3v4"))
# -------------------------------------------------------------------- #


@router.resolver(field_name="getPresignedUrl")
@tracer.capture_method
@fetch_user_id(router)
def get_presigned_url(
    user_id: str,
    s3Uri: str,
    pageNumber: Optional[int] = None,
):
    """Generate a presigned URL for accessing an S3 object.

    Args:
        user_id (str): ID of the authenticated user requesting the URL
        s3Uri (str): S3 URI in format s3://bucket-name/path/to/object
        pageNumber (Optional[int]): Page number to append to URL for PDF viewing

    Returns:
        str: Presigned URL for accessing the S3 object, with optional page number

    Example:
        >>> get_presigned_url("user123", "s3://my-bucket/doc.pdf", 5)
        'https://XXXXXXXXXXXXXXXXXXXXXXXXXX/doc.pdf?AWSAccessKeyId=...#page=5'
    """
    logger.info(f"Generating presigned URL for authenticated user {user_id}")
    # amazonq-ignore-next-line
    parts = s3Uri.replace("s3://", "").split("/")
    bucket_name = parts[0]
    object_name = "/".join(parts[1:])
    logger.info(f"Bucket: {bucket_name}")
    logger.info(f"Object key: {object_name}")
    if pageNumber:
        logger.info(f"Page number: {pageNumber}")

    url = S3_CLIENT.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket_name, "Key": object_name},
        ExpiresIn=EXPIRES_IN_SECONDS,
    )
    logger.info(f"The generated url will be valid for {EXPIRES_IN_SECONDS} seconds")
    return f"{url}#page={pageNumber}" if pageNumber else url
