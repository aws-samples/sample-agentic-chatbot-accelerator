# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ----------------------------------------------------------------------
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Mapping

import boto3
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from botocore.client import BaseClient

DEFAULT_CLIENT = boto3.client("s3")


@dataclass
class S3Object:
    """Pythonic representation of an S3 Object.

    Attributes:
        bucket_name (str): name of the bucket
        obj_key (str): key of the object
        obj_type (str): type of object
    """

    bucket_name: str
    obj_key: str
    obj_type: str


def load_json(s3_uri: str, s3_client: BaseClient, return_as_str: bool = False) -> str:
    """Load a JSON file from an Amazon S3 bucket.

    Args:
        s3_uri (str): The S3 URI of the JSON file to load (e.g., 's3://bucket-name/path/to/file.json').
        s3_client (BaseClient): A Boto3 S3 client object. If None, uses default client.
        return_as_str (bool, optional): If True, the function returns the JSON data as a string.
            Otherwise, it returns a Python dictionary. Defaults to False.

    Returns:
        Union[str, Dict]: The JSON data as a string if return_as_str is True,
            otherwise returns a Python dictionary.

    Raises:
        ValueError: If the file type is not JSON or if the specified key is not found.
        ClientError: If there is an error accessing the S3 bucket.
    """
    s3_obj = _process_uri(s3_uri)
    s3_client = s3_client if s3_client else DEFAULT_CLIENT  # type: ignore

    if s3_obj.obj_type != "json":
        raise ValueError(
            f"Invalid file type. Expected JSON file, got {s3_obj.obj_type}"
        )

    response = _safe_get_object(s3_obj, s3_client)
    json_data = json.loads(response["Body"].read().decode("utf-8"))

    return json.dumps(json_data) if return_as_str else json_data


def upload_json(
    s3_client: BaseClient, data: Mapping, destination_bucket: str, obj_key: str
) -> None:
    """Uploads a Python dictionary as a JSON file to an Amazon S3 bucket.

    Args:
        s3_client (botocore.client.S3): A Boto3 S3 client object.
        data (Mapping): A Python dictionary containing the data to be uploaded.
        destination_bucket (str): The name of the S3 bucket to upload the file to.
        obj_key (str): The key (file path) for the uploaded object in the S3 bucket.
    """
    s3_client.put_object(
        Body=json.dumps(data).encode("UTF-8"),
        Bucket=destination_bucket,
        Key=obj_key,
        ContentType="application/json",
    )


# ****************************************** Private API ***************************************** #
def _process_uri(s3_uri: str) -> S3Object:
    """Generates an S3Object from an S3 URI"""
    parts = s3_uri.split("/")
    bucket, obj_key = parts[2], "/".join(parts[3:])

    parts = obj_key.split(".")
    obj_type = "folder" if len(parts) == 1 else obj_key.split(".")[-1].lower()
    return S3Object(bucket_name=bucket, obj_key=obj_key, obj_type=obj_type)


def _safe_get_object(s3_obj: S3Object, s3_client: BaseClient) -> dict:
    try:
        response = s3_client.get_object(Bucket=s3_obj.bucket_name, Key=s3_obj.obj_key)
    except ClientError as err:
        if err.response["Error"]["Code"] == "NoSuchKey":
            raise ValueError(f"Key {s3_obj.obj_key} not found")
        else:
            raise err
    return response
