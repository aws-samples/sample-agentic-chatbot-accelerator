# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Lambda function to create vector index in OpenSearch Serverless collection.
Uses opensearch-py with requests_aws4auth for proper SigV4 authentication.
"""

import json
import logging
import time
from typing import Any
from urllib.parse import urlparse

import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from opensearchpy.exceptions import RequestError
from requests_aws4auth import AWS4Auth

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_opensearch_client(endpoint: str, region: str) -> OpenSearch:
    """Create an OpenSearch client with proper AWS authentication."""
    # Parse the endpoint to get host
    parsed = urlparse(endpoint)
    host = parsed.netloc or parsed.path.replace("https://", "").replace("http://", "")

    # Get AWS credentials
    session = boto3.Session()
    credentials = session.get_credentials()

    # Create AWS4Auth for OpenSearch Serverless
    auth = AWS4Auth(
        credentials.access_key,
        credentials.secret_key,
        region,
        "aoss",  # Service name for OpenSearch Serverless
        session_token=credentials.token,
    )

    # Create OpenSearch client
    client = OpenSearch(
        hosts=[{"host": host, "port": 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        timeout=60,
    )

    return client


def handler(event: dict, context: Any) -> dict:
    """
    Lambda handler to create vector index.

    Event structure:
    {
        "collection_endpoint": "https://xxx.aoss.amazonaws.com",
        "index_name": "bedrock-knowledge-base-default-index",
        "vector_dimension": 1024,
        "vector_field": "bedrock-knowledge-base-default-vector",
        "text_field": "AMAZON_BEDROCK_TEXT_CHUNK",
        "metadata_field": "AMAZON_BEDROCK_METADATA",
        "region": "us-east-1"
    }
    """
    logger.info(f"Event: {json.dumps(event)}")

    # Extract parameters
    endpoint = event["collection_endpoint"]
    index_name = event["index_name"]
    vector_dimension = event.get("vector_dimension", 1024)
    vector_field = event.get("vector_field", "bedrock-knowledge-base-default-vector")
    text_field = event.get("text_field", "AMAZON_BEDROCK_TEXT_CHUNK")
    metadata_field = event.get("metadata_field", "AMAZON_BEDROCK_METADATA")
    region = event.get("region", "us-east-1")

    # Index body definition
    index_body = {
        "settings": {
            "index.knn": True,
            "number_of_shards": 2,
            "number_of_replicas": 0,
            "index.knn.algo_param.ef_search": 512,
        },
        "mappings": {
            "properties": {
                vector_field: {
                    "type": "knn_vector",
                    "dimension": vector_dimension,
                    "method": {
                        "name": "hnsw",
                        "engine": "faiss",
                        "parameters": {"m": 16, "ef_construction": 512},
                        "space_type": "l2",
                    },
                },
                metadata_field: {"type": "text", "index": False},
                text_field: {"type": "text", "index": True},
            }
        },
    }

    # Retry logic
    max_retries = 5
    retry_delay = 30

    for attempt in range(1, max_retries + 1):
        logger.info(f"Attempt {attempt} of {max_retries}")

        try:
            # Create OpenSearch client
            client = get_opensearch_client(endpoint, region)

            # Check if index already exists
            if client.indices.exists(index=index_name):
                logger.info(f"Index '{index_name}' already exists")
                return {
                    "statusCode": 200,
                    "body": json.dumps(
                        {
                            "success": True,
                            "message": f"Index '{index_name}' already exists",
                        }
                    ),
                }

            # Create the index
            logger.info(f"Creating index '{index_name}'...")
            response = client.indices.create(index=index_name, body=index_body)
            logger.info(f"Create response: {response}")

            if response.get("acknowledged"):
                logger.info(f"Successfully created index '{index_name}'")
                return {
                    "statusCode": 200,
                    "body": json.dumps(
                        {
                            "success": True,
                            "message": f"Index '{index_name}' created successfully",
                        }
                    ),
                }

        except RequestError as e:
            # Check if index already exists (race condition)
            if "resource_already_exists_exception" in str(e).lower():
                logger.info(
                    f"Index '{index_name}' already exists (concurrent creation)"
                )
                return {
                    "statusCode": 200,
                    "body": json.dumps(
                        {
                            "success": True,
                            "message": f"Index '{index_name}' already exists",
                        }
                    ),
                }
            logger.error(f"RequestError: {e}")

        except Exception as e:
            error_str = str(e).lower()
            logger.error(f"Error on attempt {attempt}: {e}")

            # If 403, wait longer for policy propagation
            if "403" in error_str or "forbidden" in error_str:
                logger.warning(
                    "Got 403 - waiting for data access policy propagation..."
                )
                time.sleep(60)
                continue

        # Wait before retry
        if attempt < max_retries:
            logger.info(f"Waiting {retry_delay}s before retry...")
            time.sleep(retry_delay)

    # All retries failed
    error_msg = f"Failed to create index after {max_retries} attempts"
    logger.error(error_msg)
    return {
        "statusCode": 500,
        "body": json.dumps({"success": False, "message": error_msg}),
    }
