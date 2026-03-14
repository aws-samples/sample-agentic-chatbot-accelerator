# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Sequence

import boto3
import pydantic
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from genai_core.aoss.index_ops import IndexManager
from genai_core.aoss.types import DistanceType, Precision, VectorDatabaseConfiguration
from genai_core.api_helper.auth import fetch_user_id
from genai_core.api_helper.types import (
    ChunkingType,
)
from genai_core.api_helper.types import DataSource as DataSourceInput
from genai_core.api_helper.types import (
    KnowledgeBase,
    KnowledgeBaseProps,
    S3DataSource,
    S3Document,
    StatusResponse,
)
from genai_core.exceptions import AcaException, ReadFromDynamoError
from genai_core.processing.utils import generate_doc_hash
from retry import retry

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-knowledgeBasesRoute")
# -------------------------------------------------------------------- #

# ---------------------- AWS CLIENTS/RESOURCES ----------------------- #
BEDROCK_AGENT_CLIENT = boto3.client("bedrock-agent")
DYNAMO_DB_RESOURCE = boto3.resource("dynamodb")
S3_CLIENT = boto3.client("s3")
EVENTS_CLIENT = boto3.client("events")
# -------------------------------------------------------------------- #

# ------------------------- Environment Variables ------------------------ #
AWS_REGION = os.environ["AWS_DEFAULT_REGION"]
AWS_ACCOUNT = boto3.client("sts").get_caller_identity().get("Account")
ENV_PREFIX = os.environ["ENV_PREFIX"]
DOCUMENT_TABLE_NAME = os.environ.get("DOCUMENT_TABLE_NAME")
STACK_NAME = os.environ.get("STACK_NAME", "aca")
DATA_BUCKET_ARN = os.environ["DATA_BUCKET_ARN"]
START_PIPELINE_QUEUE_ARN = os.environ["START_PIPELINE_QUEUE_ARN"]

# KB-related environment variables (always present when Lambda is deployed)
KB_INVENTORY_TABLE_NAME = os.environ["KB_INVENTORY_TABLE_NAME"]
KB_ROLE_ARN = os.environ["KB_ROLE_ARN"]
COLLECTION_ID = os.environ["COLLECTION_ID"]
# ------------------------------------------------------------------------ #


@router.resolver(field_name="listKnowledgeBases")
@tracer.capture_method
@fetch_user_id(router)
def list_knowledge_bases(user_id: str) -> Sequence[Mapping]:
    """List knowledge bases created with ACA in the current environment.

    This function retrieves all knowledge bases from Amazon Bedrock and filters them based on:
    - Active status
    - Stack tag matching 'aca'
    - Environment tag matching ENV_PREFIX
    - Created by CDK or the current user

    Args:
        user_id (str): ID of the current user making the request

    Returns:
        Sequence[Mapping]: List of matching knowledge bases with their details defined according to `KnowledgeBase` interface

    Raises:
        ClientError: If there is an error calling the Bedrock API
    """
    knowledge_bases = []
    logger.info(f"Listing Knowledge bases created with ACA in {ENV_PREFIX} environment")
    try:
        response = BEDROCK_AGENT_CLIENT.list_knowledge_bases()
        for kb in response.get("knowledgeBaseSummaries", []):
            kb_arn = f"arn:aws:bedrock:{AWS_REGION}:{AWS_ACCOUNT}:knowledge-base/{kb['knowledgeBaseId']}"
            kb_tags = BEDROCK_AGENT_CLIENT.list_tags_for_resource(resourceArn=kb_arn)

            tags = kb_tags.get("tags", {})
            created_by = tags.get("CreatedBy", "Admin")
            if (
                kb["status"] == "ACTIVE"
                and tags.get("Stack", "missing").lower() == STACK_NAME.lower()
                and tags.get("Environment", "missing").lower() == ENV_PREFIX
                and (created_by in ("Admin", user_id))
            ):
                kb_match = KnowledgeBase(
                    name=kb["name"],
                    id=kb["knowledgeBaseId"],
                    arn=kb_arn,
                    description=kb.get("description"),
                    owner=created_by,
                )
                logger.info(f"Matching KB created by {created_by}")
                logger.info(kb_match)
                knowledge_bases.append(kb_match.model_dump(exclude_none=True))
    except ClientError as err:
        logger.exception(err)
        raise

    logger.info(f"Found {len(knowledge_bases)} knowledge bases")
    return knowledge_bases


@router.resolver(field_name="listDataSources")
@tracer.capture_method
@fetch_user_id(router)
def list_data_sources(user_id: str, kbId: str) -> Sequence[Mapping]:
    """List data sources associated with a knowledge base.

    This function retrieves all data sources from a specified knowledge base in Amazon Bedrock and filters them based on:
    - Available status
    - S3 data source type

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base to list data sources from

    Returns:
        Sequence[Mapping]: List of matching data sources with their details defined according to `S3DataSource` interface

    Raises:
        ClientError: If there is an error calling the Bedrock API
    """
    data_sources = []
    logger.info(
        f"[User {user_id}]: Listing data sources associated to the Knowledge Base {kbId}"
    )
    try:
        response = BEDROCK_AGENT_CLIENT.list_data_sources(knowledgeBaseId=kbId)

        for data_source in response.get("dataSourceSummaries", []):
            data_source_id = data_source["dataSourceId"]
            detailed_response = BEDROCK_AGENT_CLIENT.get_data_source(
                knowledgeBaseId=kbId,
                dataSourceId=data_source_id,
            )
            ds_configuration = detailed_response.get("dataSource", {}).get(
                "dataSourceConfiguration", {}
            )
            ds_type = ds_configuration.get("type")

            ds_status = data_source.get("status")

            # note that it is not possible to associate tags to KB data source / assuming that KB was created with ACA
            if ds_status == "AVAILABLE" and ds_type == "S3":
                match_ds = S3DataSource(
                    name=data_source["name"],
                    id=data_source_id,
                    prefixes=ds_configuration["s3Configuration"]["inclusionPrefixes"],
                    description=data_source.get("description"),
                )
                logger.info(match_ds)
                data_sources.append(match_ds.model_dump(exclude_none=True))

    except ClientError as err:
        logger.exception(err)
        raise

    logger.info(f"Found {len(data_sources)} data sources")
    return data_sources


@router.resolver(field_name="listDocuments")
@tracer.capture_method
@fetch_user_id(router)
def list_documents(user_id: str, prefixes: Sequence[str]) -> Sequence[Mapping]:
    """List documents stored in DynamoDB that match the given S3 prefixes.

    Args:
        user_id (str): ID of the current user making the request
        prefixes (Sequence[str]): List of S3 prefixes to filter documents by

    Returns:
        Sequence[Mapping]: List of matching documents with their details defined according to S3Document interface

    Raises:
        ValueError: If DOCUMENT_TABLE_NAME environment variable is not defined
        ReadFromDynamoError: If there is an error querying the DynamoDB table
    """
    if not DOCUMENT_TABLE_NAME:
        raise ValueError("Environment variable DOCUMENT_TABLE_NAME is not defined")

    table = DYNAMO_DB_RESOURCE.Table(DOCUMENT_TABLE_NAME)  # type: ignore

    def _query() -> Sequence:
        filter_expression = Attr("DataSourcePrefix").is_in(prefixes)
        projection_expression = (
            "DocumentId, BucketName, DocumentType, ObjectName, RawInputPrefix"
        )

        response = table.scan(
            FilterExpression=filter_expression,
            ProjectionExpression=projection_expression,
        )
        return response.get("Items", [])

    try:
        documents = _query()
    except ClientError as err:
        logger.exception(err)
        raise ReadFromDynamoError(DOCUMENT_TABLE_NAME) from err
    logger.info(
        f"[User {user_id}]: Found {len(documents)} under S3 data sources prefixes {prefixes}"
    )
    return [S3Document(**item).as_query_response() for item in documents]


@router.resolver(field_name="deleteDocument")
@tracer.capture_method
@fetch_user_id(router)
def delete_document(user_id: str, uri: str) -> Mapping:
    """Remove S3 document given uri.

    Args:
        user_id (str): ID of the current user making the request
        uri (str): S3 URI of document to delete in format s3://bucket/key

    Returns:
        Mapping: Dictionary containing:
            - id (str): The original S3 URI
            - deleted (bool): True if document was deleted successfully, False otherwise

    Raises:
        ClientError: If there is an error deleting from S3
        ValueError: If URI is not in valid format (must be s3://bucket/key)
    """
    logger.info(f"[User {user_id}]: Deleting document {uri}")
    response = {"id": uri, "deleted": False}

    try:
        if not uri.startswith("s3://"):
            raise ValueError("URI must start with s3://")

        parts = uri.replace("s3://", "").split("/", 1)
        if len(parts) != 2:
            raise ValueError("Invalid S3 URI format")

        bucket = parts[0]
        key = parts[1]

        S3_CLIENT.delete_object(Bucket=bucket, Key=key)

        logger.info(f"Successfully deleted s3://{bucket}/{key}")
        response["deleted"] = True

    except ClientError as err:
        logger.exception(err)

    return response


@router.resolver(field_name="getInputPrefix")
@tracer.capture_method
@fetch_user_id(router)
def get_input_prefix(user_id: str, kbId: str, dataSourceID: str) -> str:
    """Get the raw input prefix associated with a knowledge base data source.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base
        dataSourceID (str): ID of the data source within the knowledge base

    Returns:
        str: The raw input prefix associated with the data source

    Raises:
        ReadFromDynamoError: If there is an error querying the DynamoDB table
        AssertionError: If the query returns more than one item (should be unique)
        KeyError: If the RawInputPrefix attribute is missing from the item
    """
    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore

    logger.info(
        f"User {user_id} is asking for the input data prefix associated with data source [{dataSourceID}] of the KB [{kbId}]"
    )

    try:
        response = table.query(
            KeyConditionExpression=Key("KnowledgeBaseId").eq(kbId)
            & Key("DataSourceId").eq(dataSourceID),
            ProjectionExpression="RawInputPrefix",
        )

    except ClientError as err:
        logger.exception(err)
        raise ReadFromDynamoError(KB_INVENTORY_TABLE_NAME) from err  # type: ignore[arg-type]

    items = response.get("Items", [])
    if len(items) != 1:
        raise AssertionError(False, "Key combination should be unique")

    prefix = items[0].get("RawInputPrefix")
    if not prefix:
        raise KeyError(
            f"Missing attribute [RawInputPrefix] for KB [{kbId}] and data source [{dataSourceID}]"
        )

    return prefix


@router.resolver(field_name="checkOnProcessStarted")
@tracer.capture_method
@fetch_user_id(router)
def check_on_process_started(user_id: str, s3ObjectNames: Sequence[str]) -> bool:
    """Check if document processing has started for all specified S3 objects."""
    logger.info(
        f"User [{user_id}] requested to add {len(s3ObjectNames)} to the data source."
    )
    key_values, found_items = _batch_get_documents(s3ObjectNames)
    response = bool(key_values) and len(found_items) == len(s3ObjectNames)
    logger.info(
        "Processing pipeline correctly started"
        if response
        else "Pending pipeline kick-off"
    )
    return response


@router.resolver(field_name="checkOnDocumentsRemoved")
@tracer.capture_method
@fetch_user_id(router)
def check_on_documents_removed(user_id: str, s3ObjectNames: Sequence[str]) -> bool:
    """Check if documents have been removed from DynamoDB."""
    logger.info(
        f"User [{user_id}] requested to remove {len(s3ObjectNames)} to the data source."
    )
    logger.info(s3ObjectNames)
    key_values, found_items = _batch_get_documents(s3ObjectNames)
    response = bool(key_values) and len(found_items) == 0
    logger.info("Documents removed" if response else "Cleanup in progress")
    return response


@router.resolver(field_name="checkOnSyncInProgress")
@tracer.capture_method
@fetch_user_id(router)
def check_on_kb_sync_in_progress(user_id: str, kbId: str) -> bool:
    """Check if a knowledge base data source sync is currently in progress.

    This function checks the status of the latest ingestion job for a given knowledge base data source
    to determine if synchronization is still ongoing.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base to check

    Returns:
        bool: True if sync is in progress (status is 'IN_PROGRESS' or 'PENDING'), False otherwise

    Raises:
        ClientError: If there is an error calling the Bedrock API
    """
    logger.info(
        f"User [{user_id}] is using the playground. Check if sync is in progress."
    )
    is_in_progress = False
    try:
        response_ds_list = BEDROCK_AGENT_CLIENT.list_data_sources(knowledgeBaseId=kbId)

        for data_source in response_ds_list.get("dataSourceSummaries", []):
            data_source_id = data_source["dataSourceId"]

            response = BEDROCK_AGENT_CLIENT.list_ingestion_jobs(
                knowledgeBaseId=kbId,
                dataSourceId=data_source_id,
            )

            if response.get("ingestionJobSummaries"):
                # Some objects might fail because of launching sync while another is already running
                # We remove those "known" conditions from the analysis
                active_jobs = [
                    job
                    for job in response["ingestionJobSummaries"]
                    if job.get("status") != "FAILED"
                ]
                if active_jobs:
                    latest_job = response["ingestionJobSummaries"][0]
                    job_id = latest_job.get("ingestionJobId")
                    logger.info(f"Latest ingestion job ID is: {job_id}")
                    job_status = latest_job.get("status")
                    logger.info(f"Job {job_id} status = {job_status}")
                    is_in_progress = job_status in ["IN_PROGRESS", "PENDING"]

                    if is_in_progress:
                        break

    except ClientError as err:
        logger.exception(err)
        raise
    return is_in_progress


@router.resolver(field_name="checkOnProcessCompleted")
@tracer.capture_method
@fetch_user_id(router)
def check_on_process_completed(user_id: str, s3ObjectNames: Sequence[str]) -> bool:
    """Check if document processing has completed for all specified S3 objects."""
    logger.info(
        f"User [{user_id}] requested to add {len(s3ObjectNames)} to the data source."
    )
    key_values, found_items = _batch_get_documents(
        s3ObjectNames, projection_expression="DocumentId, DocumentStatus"
    )
    response = (
        bool(key_values)
        and len(found_items) == len(s3ObjectNames)
        and all(item.get("DocumentStatus") != "IN_PROGRESS" for item in found_items)
    )
    logger.info("Documents added" if response else "Processing pipeline in progress")
    return response


@router.resolver(field_name="createKnowledgeBase")
@tracer.capture_method
@fetch_user_id(router)
def create_knowledge_base(user_id: str, kbName: str, props: str) -> Dict:
    """Create a new knowledge base with vector search capabilities.

    This function creates a new knowledge base in Amazon Bedrock with:
    - OpenSearch Serverless vector index for storage
    - Specified embedding model configuration
    - Field mappings for vectors, text and metadata

    Args:
        user_id (str): ID of the current user making the request
        kbName (str): Name of the knowledge base to create
        props (str): JSON string containing data source properties. See `KnowledgeBaseProps` for schema.

    Returns:
        Dict: Dictionary containing:
            - id (str): ID of created knowledge base
            - status (str): Status code indicating success/failure:
                - SUCCESSFUL: Knowledge base created successfully
                - INVALID_CONFIG: Invalid configuration provided
                - ALREADY_EXISTS: Knowledge base with same name exists
                - SERVICE_ERROR: Error creating vector index
                - KB_NOT_ENABLED: Knowledge Base feature is not enabled
                - UNKNOWN_ERROR: Unexpected error occurred

    Raises:
        ClientError: If there is an error creating the knowledge base
        ValueError: If required properties are missing or invalid
    """
    logger.info(f"User [{user_id}] wants to create a new Knowledge base")

    # Validate arguments
    try:
        loaded_props = json.loads(props)
        loaded_props["name"] = kbName.replace(" ", "-")
        parsed_props = KnowledgeBaseProps(**loaded_props)
    except (json.JSONDecodeError, pydantic.ValidationError):
        logger.error("Invalid configuration")
        return {"status": StatusResponse.INVALID_CONFIG.value}

    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore

    # Check if Kb created by user exists already
    try:
        response = BEDROCK_AGENT_CLIENT.list_knowledge_bases()
        for kb in response.get("knowledgeBaseSummaries", []):
            kb_arn = f"arn:aws:bedrock:{AWS_REGION}:{AWS_ACCOUNT}:knowledge-base/{kb['knowledgeBaseId']}"
            kb_tags = BEDROCK_AGENT_CLIENT.list_tags_for_resource(resourceArn=kb_arn)
            tags = kb_tags.get("tags", {})
            created_by = tags.get("CreatedBy", "Admin")
            if (
                kb["name"] == parsed_props.name
                and tags.get("Stack", "missing").lower() == STACK_NAME.lower()
                and tags.get("Environment", "missing").lower() == ENV_PREFIX
                and created_by == user_id
            ):
                logger.warning(
                    f"Knowledge base with name {parsed_props.name} already exists"
                )
                return {"status": StatusResponse.ALREADY_EXISTS.value}
    except ClientError as err:
        logger.error(err)
        logger.exception(err)
        return {"status": StatusResponse.UNKNOWN_ERROR.value}

    logger.info("Initializing open search serverless client...")
    index_manager = IndexManager(
        collection_id=COLLECTION_ID,  # type: ignore[arg-type]
        aws_region=AWS_REGION,
        logger=logger,
    )
    logger.info(f"Ready to add index to collection {COLLECTION_ID}")
    index_name = f"index-of-{parsed_props.name.lower()}"[:32]
    try:
        index_manager.create_index(
            index_name=index_name,
            config=VectorDatabaseConfiguration(
                dimension=parsed_props.model.vectorSize,
                precision=Precision(parsed_props.model.precision.value.lower()),
                distance_type=DistanceType(
                    "hamming"
                    if parsed_props.model.precision.value.lower() == "binary"
                    else "l2"
                ),
            ),
        )
    except AcaException as err:
        logger.error(err)
        return {"status": StatusResponse.SERVICE_ERROR.value}

    logger.info(f"Creating index named {index_name}")

    opensearchServerlessConfiguration = {
        "collectionArn": f"arn:aws:aoss:{AWS_REGION}:{AWS_ACCOUNT}:collection/{COLLECTION_ID}",
        "vectorIndexName": index_name,
        "fieldMapping": {
            "vectorField": index_manager.__vector_field_name__,
            "textField": index_manager.__text_chunk_name__,
            "metadataField": index_manager.__metadata_name__,
        },
    }

    try:
        response = _create_kb_with_retry(
            user_id, parsed_props, opensearchServerlessConfiguration
        )
        kb_id = response.get("knowledgeBase", {}).get("knowledgeBaseId", "AssertFalse")
        logger.info(f"Successfully created the Knowledge Base {kb_id}")

        for data_source_props in parsed_props.dataSources:
            _create_data_source(table, user_id, kb_id, data_source_props)

    except ClientError as err:
        logger.error("Knowledge base creation failed")
        logger.exception(err)
        return {"status": StatusResponse.UNKNOWN_ERROR.value}

    return {
        "id": kb_id,
        "status": StatusResponse.SUCCESSFUL.value,
    }


@router.resolver(field_name="createDataSource")
@tracer.capture_method
@fetch_user_id(router)
def create_data_source(user_id: str, kbId: str, dsName: str, props: str) -> Dict:
    """Create a new data source in an existing knowledge base.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base to add the data source to
        dsName (str): Name of the data source to create
        props (str): JSON string containing data source properties. See `DataSourceInput` for schema.

    Returns:
        Dict: Dictionary containing:
            - id (str): ID of created data source
            - status (str): Status code indicating success/failure:
                - SUCCESSFUL: Data source created successfully
                - INVALID_CONFIG: Invalid configuration provided
                - ALREADY_EXISTS: Data source with same name exists
                - KB_NOT_ENABLED: Knowledge Base feature is not enabled
                - UNKNOWN_ERROR: Unexpected error occurred

    Raises:
        ClientError: If there is an error creating the data source
    """
    try:
        loaded_props = json.loads(props)
        loaded_props["id"] = dsName.replace(" ", "-")
        parsed_props = DataSourceInput(**loaded_props)
    except (json.JSONDecodeError, pydantic.ValidationError):
        logger.error("Invalid configuration")
        return {"status": StatusResponse.INVALID_CONFIG.value}

    # Check that data source dsName does not exist already
    try:
        response = BEDROCK_AGENT_CLIENT.list_data_sources(knowledgeBaseId=kbId)
        for ds in response.get("dataSourceSummaries", []):
            if ds["name"] == dsName:
                logger.warning(f"Data source with name {dsName} already exists")
                return {"status": StatusResponse.ALREADY_EXISTS.value}
    except ClientError as err:
        logger.error(err)
        logger.exception(err)
        return {"status": StatusResponse.UNKNOWN_ERROR.value}

    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore

    try:
        ds_id = _create_data_source(table, user_id, kbId, parsed_props)
    except ClientError as err:
        logger.error(err)
        logger.exception(err)
        return {"status": StatusResponse.UNKNOWN_ERROR.value}

    return {
        "id": ds_id,
        "status": StatusResponse.SUCCESSFUL.value,
    }


@router.resolver(field_name="deleteKnowledgeBase")
@tracer.capture_method
@fetch_user_id(router)
def delete_knowledge_base(user_id: str, kbId: str) -> Dict:
    """Delete a knowledge base and its associated vector index.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base to delete

    Returns:
        Dict: Dictionary containing:
            - id (str): ID of the deleted knowledge base
            - successful (bool): True if deletion succeeded, False otherwise

    Raises:
        ClientError: If there is an error deleting the knowledge base or vector index
    """
    status = StatusResponse.UNKNOWN_ERROR.value
    kb_arn = f"arn:aws:bedrock:{AWS_REGION}:{AWS_ACCOUNT}:knowledge-base/{kbId}"
    kb_tags = BEDROCK_AGENT_CLIENT.list_tags_for_resource(resourceArn=kb_arn)
    tags = kb_tags.get("tags", {})
    created_by = tags.get("CreatedBy", "CDK")
    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore

    if created_by != user_id:
        logger.warning(
            f"The knowledge [{kbId}] was created by [{created_by}], and [{user_id}] is not allowed to remove it."
        )
    else:
        try:
            kb_props = BEDROCK_AGENT_CLIENT.get_knowledge_base(knowledgeBaseId=kbId)
            logger.info(kb_props)

            vector_index_name = kb_props["knowledgeBase"]["storageConfiguration"][
                "opensearchServerlessConfiguration"
            ]["vectorIndexName"]
            logger.info(vector_index_name)

            response_list_ds = BEDROCK_AGENT_CLIENT.list_data_sources(
                knowledgeBaseId=kbId
            )
            data_source_ids = [
                elem["dataSourceId"]
                for elem in response_list_ds.get("dataSourceSummaries", [])
            ]

            BEDROCK_AGENT_CLIENT.delete_knowledge_base(knowledgeBaseId=kbId)

            _check_on_kb_delete(kbId)

            logger.info(f"Deleted Knowledge Base {kbId}")

            index_manager = IndexManager(
                collection_id=COLLECTION_ID,
                aws_region=AWS_REGION,
                logger=logger,
            )
            successful_index_delete = index_manager.delete_index(vector_index_name)
            logger.info(
                f"Deleted aoss index {vector_index_name} ? {successful_index_delete}"
            )
            eventbridge_rules = []

            for ds_id in data_source_ids:
                item = table.get_item(
                    Key={
                        "KnowledgeBaseId": kbId,
                        "DataSourceId": ds_id,
                    }
                )
                if "Item" in item:
                    if item["Item"].get("S3DataProcessingRuleName"):
                        eventbridge_rules.append(
                            item["Item"]["S3DataProcessingRuleName"]
                        )
                    table.delete_item(
                        Key={
                            "KnowledgeBaseId": kbId,
                            "DataSourceId": ds_id,
                        }
                    )
                    logger.info(f"Remove record {kbId}-{ds_id} from DynamoDB table")
                else:
                    logger.warning(
                        f"No item found for {kbId}-{ds_id} in DynamoDB table"
                    )

            for eventbridge_rule_name in eventbridge_rules:
                if not _is_eventbrige_rule_used(
                    rule_name=eventbridge_rule_name,
                    kb_inventory_table=table,
                ):
                    _delete_eventbridge_rule(
                        rule_name=eventbridge_rule_name,
                    )
                    logger.info(
                        f"EventBridge Rule {eventbridge_rule_name} successfully deleted."
                    )
                else:
                    logger.info(
                        f"EventBridge Rule {eventbridge_rule_name} is in use. Skipping deletion."
                    )

            status = StatusResponse.SUCCESSFUL.value
        except ClientError as err:
            logger.error(err)
            logger.exception(err)
    return {
        "id": kbId,
        "status": status,
    }


@router.resolver(field_name="deleteDataSource")
@tracer.capture_method
@fetch_user_id(router)
def delete_data_source(user_id: str, kbId: str, dataSourceId: str) -> Dict:
    """Delete a data source from a knowledge base.

    Only the user who created the knowledge base is allowed to delete its data sources.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base containing the data source
        dataSourceId (str): ID of the data source to delete

    Returns:
        Dict: Dictionary containing:
            - id (str): ID of the deleted data source
            - successful (bool): True if deletion succeeded, False otherwise

    Raises:
        ClientError: If there is an error deleting the data source
    """
    status = StatusResponse.UNKNOWN_ERROR.value

    kb_arn = f"arn:aws:bedrock:{AWS_REGION}:{AWS_ACCOUNT}:knowledge-base/{kbId}"
    kb_tags = BEDROCK_AGENT_CLIENT.list_tags_for_resource(resourceArn=kb_arn)
    tags = kb_tags.get("tags", {})
    created_by = tags.get("CreatedBy", "CDK")
    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore

    if created_by != user_id:
        logger.warning(
            f"The knowledge [{kbId}] was created by [{created_by}], and [{user_id}] is not allowed to remove data source from it."
        )
    else:
        try:
            BEDROCK_AGENT_CLIENT.delete_data_source(
                knowledgeBaseId=kbId,
                dataSourceId=dataSourceId,
            )
            item = table.get_item(
                Key={
                    "KnowledgeBaseId": kbId,
                    "DataSourceId": dataSourceId,
                }
            )
            table.delete_item(
                Key={
                    "KnowledgeBaseId": kbId,
                    "DataSourceId": dataSourceId,
                }
            )

            if "Item" not in item:
                logger.warning(
                    f"No item found for {kbId}-{dataSourceId} in DynamoDB table"
                )

            else:
                item = item["Item"]
                if item.get("S3DataProcessingRuleName"):
                    if not _is_eventbrige_rule_used(
                        rule_name=item["S3DataProcessingRuleName"],
                        kb_inventory_table=table,
                    ):
                        _delete_eventbridge_rule(
                            rule_name=item["S3DataProcessingRuleName"],
                        )
                        logger.info(
                            f"EventBridge Rule {item['S3DataProcessingRuleName']} successfully deleted."
                        )
                    else:
                        logger.info(
                            f"EventBridge Rule {item['S3DataProcessingRuleName']} in use"
                        )
                else:
                    logger.warning("No S3DataProcessingRuleName found")
                    logger.debug(f"item: {item}")

            status = StatusResponse.SUCCESSFUL.value

        except ClientError as err:
            logger.error(err)
            logger.exception(err)

    return {
        "id": dataSourceId,
        "status": status,
    }


@router.resolver(field_name="syncKnowledgeBase")
@tracer.capture_method
@fetch_user_id(router)
def sync_knowledge_base(user_id: str, kbId: str) -> Dict:
    """Synchronize all data sources in a knowledge base.

    Args:
        user_id (str): ID of the current user making the request
        kbId (str): ID of the knowledge base to synchronize

    Returns:
        Dict: Dictionary containing:
            - id (str): ID of the knowledge base that was synchronized
            - successful (bool): True if sync jobs were started successfully, False otherwise

    Raises:
        ClientError: If there is an error starting the ingestion jobs
    """
    status = StatusResponse.UNKNOWN_ERROR.value
    logger.info(
        f"User [{user_id}] is starting a sync job on all the data sources associated with the Knowledge base {kbId}"
    )
    table = DYNAMO_DB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME)  # type: ignore
    try:
        response = BEDROCK_AGENT_CLIENT.list_data_sources(knowledgeBaseId=kbId)
        for data_source in response.get("dataSourceSummaries", []):
            data_source_id = data_source["dataSourceId"]

            BEDROCK_AGENT_CLIENT.start_ingestion_job(
                dataSourceId=data_source_id,
                knowledgeBaseId=kbId,
            )
            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            table.update_item(
                Key={
                    "KnowledgeBaseId": kbId,
                    "DataSourceId": data_source_id,
                },
                UpdateExpression="SET S3RequestTimestamp = :currentTime",
                ExpressionAttributeValues={
                    ":currentTime": timestamp,
                },
            )

        status = StatusResponse.SUCCESSFUL.value
    except ClientError as err:
        logger.error(err)
        logger.exception(err)

    return {
        "id": kbId,
        "status": status,
    }


### Helpers ###
def _batch_get_documents(
    s3ObjectNames: Sequence[str], projection_expression: Optional[str] = None
) -> tuple[list, list]:
    """Common function to get documents from DynamoDB.

    Args:
        s3ObjectNames (Sequence[str]): List of S3 object names to query
        projection_expression (str, optional): DynamoDB projection expression

    Returns:
        tuple: (key_values, found_items)

    Raises:
        ReadFromDynamoError: If there is an error querying the DynamoDB table
    """
    logger.info(s3ObjectNames)
    key_values = [{"DocumentId": generate_doc_hash(elem)} for elem in s3ObjectNames]

    if not key_values:
        return [], []

    logger.info(key_values)

    request_items: dict[str, Any] = {"Keys": key_values}
    if projection_expression:
        request_items["ProjectionExpression"] = projection_expression

    try:
        response = DYNAMO_DB_RESOURCE.meta.client.batch_get_item(  # type: ignore
            RequestItems={DOCUMENT_TABLE_NAME: request_items}
        )
    except ClientError as err:
        logger.exception(err)
        raise ReadFromDynamoError(KB_INVENTORY_TABLE_NAME) from err  # type: ignore[arg-type]

    found_items = response.get("Responses", {}).get(DOCUMENT_TABLE_NAME, [])
    return key_values, found_items


@retry(delay=5, backoff=1, max_delay=10, tries=4, jitter=(0, 5))
def _create_kb_with_retry(
    user_id: str,
    kb_props: KnowledgeBaseProps,
    opensearchServerlessConfiguration: Dict,
) -> Mapping:
    """Helper function to create a knowledge base with retry logic."""
    tags = {
        "Stack": STACK_NAME.lower(),
        "CreatedBy": user_id,
    }
    if ENV_PREFIX:
        tags["Environment"] = ENV_PREFIX.lower()
    args = {
        "name": kb_props.name,
        "roleArn": KB_ROLE_ARN,
        "knowledgeBaseConfiguration": {
            "type": "VECTOR",
            "vectorKnowledgeBaseConfiguration": {
                "embeddingModelArn": f"arn:aws:bedrock:{AWS_REGION}::foundation-model/{kb_props.model.id}",
                "embeddingModelConfiguration": {
                    "bedrockEmbeddingModelConfiguration": {
                        "dimensions": kb_props.model.vectorSize,
                        "embeddingDataType": kb_props.model.precision_for_kb,
                    }
                },
            },
        },
        "storageConfiguration": {
            "type": "OPENSEARCH_SERVERLESS",
            "opensearchServerlessConfiguration": opensearchServerlessConfiguration,
        },
        "tags": tags,
    }
    if kb_props.description:
        args["description"] = kb_props.description

    logger.info(args)
    response = BEDROCK_AGENT_CLIENT.create_knowledge_base(**args)
    logger.info(response)
    return response


def _create_data_source(
    table: Any, user_id: str, kb_id: str, props: DataSourceInput
) -> str:
    """Implementation of association of a data source to an existing knowledge base"""
    chunking_configuration: dict[str, Any] = {
        "chunkingStrategy": props.chunkingProps.type.value
    }
    if props.chunkingProps.type == ChunkingType.FIXED:
        if props.chunkingProps.fixedChunkingProps is None:
            raise AssertionError(
                "Illogical error: `props.chunkingProps.fixedChunkingProps` cannot be none for `ChunkingType.FIXED`"
            )
        chunking_configuration["fixedSizeChunkingConfiguration"] = {
            "maxTokens": props.chunkingProps.fixedChunkingProps.maxTokens,
            "overlapPercentage": props.chunkingProps.fixedChunkingProps.overlapPercentage,
        }
    elif props.chunkingProps.type == ChunkingType.HIERARCHICAL:
        if props.chunkingProps.hierarchicalChunkingProps is None:
            raise AssertionError(
                "Illogical error: `props.chunkingProps.hierarchicalChunkingProps` cannot be none for `ChunkingType.HIERARCHICAL`"
            )

        chunking_configuration["hierarchicalChunkingConfiguration"] = {
            "levelConfigurations": [
                {
                    "maxTokens": props.chunkingProps.hierarchicalChunkingProps.maxParentTokenSize
                },
                {
                    "maxTokens": props.chunkingProps.hierarchicalChunkingProps.maxChildTokenSize
                },
            ],
            "overlapTokens": props.chunkingProps.hierarchicalChunkingProps.overlapTokens,
        }
    elif props.chunkingProps.type == ChunkingType.SEMANTIC:
        if props.chunkingProps.semanticChunkingProps is None:
            raise AssertionError(
                "Illogical error: `props.chunkingProps.semanticChunkingProps` cannot be none for `ChunkingType.SEMANTIC`"
            )

        chunking_configuration["semanticChunkingConfiguration"] = {
            "breakpointPercentileThreshold": props.chunkingProps.semanticChunkingProps.breakpointPercentileThreshold,
            "bufferSize": props.chunkingProps.semanticChunkingProps.bufferSize,
            "maxTokens": props.chunkingProps.semanticChunkingProps.maxTokens,
        }
    else:
        raise ValueError(
            f"Add implementation for chunking type {props.chunkingProps.type}"
        )

    create_data_source_args = {
        "dataDeletionPolicy": "DELETE",
        "dataSourceConfiguration": {
            "s3Configuration": {
                "bucketArn": DATA_BUCKET_ARN,
                "bucketOwnerAccountId": AWS_ACCOUNT,
                "inclusionPrefixes": [props.dataSourcePrefix],
            },
            "type": "S3",
        },
        "knowledgeBaseId": kb_id,
        "name": props.id,
        "vectorIngestionConfiguration": {
            "chunkingConfiguration": chunking_configuration,
        },
    }

    # Only include description if it's not empty
    if props.description and props.description.strip():
        create_data_source_args["description"] = props.description

    response_ds_creation = BEDROCK_AGENT_CLIENT.create_data_source(
        **create_data_source_args
    )

    ds_id = response_ds_creation["dataSource"]["dataSourceId"]

    rule_name = _get_or_create_event_rule(
        dataSourcePrefix=props.dataSourcePrefix,
        inputPrefix=props.inputPrefix,
        kbInventoryTable=table,
        user_id=user_id,
    )

    table.update_item(
        Key={
            "KnowledgeBaseId": kb_id,
            "DataSourceId": ds_id,
        },
        UpdateExpression="SET DataSourcePrefix = :dsPrefix, RawInputPrefix = :rawPrefix, CreatedBy = :creator, S3DataProcessingRuleName = :s3DataProcessingRuleName",
        ExpressionAttributeValues={
            ":dsPrefix": props.dataSourcePrefix,
            ":rawPrefix": props.inputPrefix,
            ":creator": user_id,
            ":s3DataProcessingRuleName": rule_name,
        },
    )
    return ds_id


@retry(delay=5, backoff=1, max_delay=10, tries=4, jitter=(0, 5))
def _check_on_kb_delete(kb_id: str):
    try:
        status_response = BEDROCK_AGENT_CLIENT.get_knowledge_base(knowledgeBaseId=kb_id)
        status = status_response.get("status")
        logger.info(f"Status of KB {kb_id}: {status}")
        raise AcaException("Delete in progress")  # raise exception here to force retry
    except BEDROCK_AGENT_CLIENT.exceptions.ResourceNotFoundException:
        # KB no longer exists - deletion successful
        logger.info(f"KB {kb_id} successfully deleted.")
        return


def _delete_eventbridge_rule(rule_name: str) -> None:
    """
    Delete an EventBridge rule and its associated targets.

    Args:
        rule_name (str): The name of the EventBridge rule to be deleted.

    Returns:
        None
    """
    list_targets_response = EVENTS_CLIENT.list_targets_by_rule(Rule=rule_name)
    target_ids = [target["Id"] for target in list_targets_response.get("Targets", [])]
    EVENTS_CLIENT.remove_targets(Rule=rule_name, Ids=target_ids)
    EVENTS_CLIENT.delete_rule(Name=rule_name)


def _get_or_create_event_rule(
    dataSourcePrefix: str,
    inputPrefix: str,
    kbInventoryTable: Any,
    user_id: str,
) -> str:
    """
    Get an existing EventBridge rule or create a new one for S3 data processing.

    This function first attempts to find an existing rule that matches the given
    data source and input prefixes. If no matching rule is found, it creates a new
    EventBridge rule for processing S3 events (object creation and deletion) for
    the specified input prefix.

    Args:
        dataSourcePrefix (str): The prefix for the data source in S3.
        inputPrefix (str): The prefix for the input data in S3.
        kbInventoryTable (Any): The DynamoDB table object for the knowledge base inventory.
        user_id (str): Cognito user id.

    Returns:
        str: The name of the existing or newly created EventBridge rule.
    """
    rule_name = _find_existing_rule(dataSourcePrefix, inputPrefix, kbInventoryTable)
    if not rule_name:
        logger.info("Creating new EventBridge Rule")
        random_uuid = str(uuid.uuid4())
        rule_name = f"{ENV_PREFIX.lower()}-{STACK_NAME.lower()}stack-{random_uuid}"
        EVENTS_CLIENT.put_rule(
            Name=rule_name,
            EventPattern=json.dumps(
                {
                    "source": ["aws.s3"],
                    "detail-type": ["Object Created", "Object Deleted"],
                    "detail": {
                        "bucket": {"name": [DATA_BUCKET_ARN.split(":")[-1]]},
                        "object": {"key": [{"prefix": f"{inputPrefix}/"}]},
                    },
                }
            ),
            Tags=[
                {"Key": "Stack", "Value": STACK_NAME},
                {"Key": "Environment", "Value": ENV_PREFIX},
                {"Key": "CreatedBy", "Value": user_id},
            ],
        )

        EVENTS_CLIENT.put_targets(
            Rule=rule_name,
            Targets=[
                {
                    "Id": f"{random_uuid}-default",
                    "Arn": START_PIPELINE_QUEUE_ARN,
                    "InputTransformer": {
                        "InputPathsMap": {
                            "detail-bucket-name": "$.detail.bucket.name",
                            "detail-object-etag": "$.detail.object.etag",
                            "detail-object-key": "$.detail.object.key",
                            "detail-type": "$.detail-type",
                            "time": "$.time",
                        },
                        "InputTemplate": json.dumps(
                            {
                                "bucket": "<detail-bucket-name>",
                                "key": "<detail-object-key>",
                                "s3RequestTimestamp": "<time>",
                                "etag": "<detail-object-etag>",
                                "detailType": "<detail-type>",
                                "prefixInput": inputPrefix,
                                "prefixDataSource": dataSourcePrefix,
                                "prefixProcessing": "processing",
                                "midfixStaging": "input",
                                "midfixTranscribe": "transcribe",
                                "transcribeJobPrefix": re.sub(
                                    r"[^a-z0-9._-]+", "-", STACK_NAME.lower()
                                ),
                                "stackName": STACK_NAME,
                                "languageCode": "en-US",
                            }
                        ),
                    },
                }
            ],
        )
        logger.info(f"EventBridge Rule {rule_name} successfully created.")
    else:
        logger.info(f"Using already existing EventBridge Rule {rule_name}.")
    return rule_name


def _find_existing_rule(
    dataSourcePrefix: str, inputPrefix: str, kbInventoryTable: Any
) -> Optional[str]:
    """
    Find an existing EventBridge rule for a given data source and input prefix combination.

    This function scans the knowledge base inventory table to find an existing EventBridge rule
    that matches the provided data source prefix and input prefix. It's used to avoid creating
    duplicate rules for the same S3 event configuration.

    Args:
        dataSourcePrefix (str): The prefix for the data source in S3.
        inputPrefix (str): The prefix for the input data in S3.
        kbInventoryTable (Any): The DynamoDB table object for the knowledge base inventory.

    Returns:
        Optional[str]: The name of the existing EventBridge rule if found, None otherwise.
    """
    response = kbInventoryTable.scan(
        ProjectionExpression="DataSourcePrefix, RawInputPrefix, S3DataProcessingRuleName"
    )

    data = response["Items"]

    while "LastEvaluatedKey" in response:
        response = kbInventoryTable.scan(
            ProjectionExpression="DataSourcePrefix, RawInputPrefix, S3DataProcessingRuleName",
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        data.extend(response["Items"])

    for item in data:
        if (
            item["DataSourcePrefix"] == dataSourcePrefix
            and item["RawInputPrefix"] == inputPrefix
        ):
            return item["S3DataProcessingRuleName"]
    return None


def _is_eventbrige_rule_used(rule_name: str, kb_inventory_table: Any) -> bool:
    """
    Check if an EventBridge rule is still in use by any knowledge base.

    This function scans the knowledge base inventory table to determine
    if the given EventBridge rule name is associated with any existing
    knowledge base data sources.

    Args:
        rule_name (str): The name of the EventBridge rule to check.
        kb_inventory_table (Any): The DynamoDB table object for the knowledge base inventory.

    Returns:
        bool: True if the rule is still in use, False otherwise.
    """
    response = kb_inventory_table.scan(ProjectionExpression="S3DataProcessingRuleName")

    data = response["Items"]

    while "LastEvaluatedKey" in response:
        response = kb_inventory_table.scan(
            ProjectionExpression="S3DataProcessingRuleName",
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        data.extend(response["Items"])

    for item in data:
        if item.get("S3DataProcessingRuleName") == rule_name:
            return True
    return False
