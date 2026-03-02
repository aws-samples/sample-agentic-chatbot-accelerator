# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import AppSyncResolver
from aws_lambda_powertools.logging import correlation_paths
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from pydantic import ValidationError

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# -------- Lambda PT Logger and Tracing -------- #
SERVICE_ID = "graphQL-experimentOps"
tracer = Tracer(service=SERVICE_ID)
logger = Logger(service=SERVICE_ID)
# ---------------------------------------------- #

# -------------------- Env Variables ----------------------- #
EXPERIMENTS_TABLE_NAME = os.environ.get("EXPERIMENTS_TABLE_NAME", "")
EXPERIMENTS_BUCKET_NAME = os.environ.get("EXPERIMENTS_BUCKET_NAME", "")
BATCH_JOB_QUEUE = os.environ.get("BATCH_JOB_QUEUE", "")
BATCH_JOB_DEFINITION = os.environ.get("BATCH_JOB_DEFINITION", "")
# ---------------------------------------------------------- #

# --------------- DynamoDB Tables ------------------- #
EXPERIMENTS_TABLE = boto3.resource("dynamodb").Table(EXPERIMENTS_TABLE_NAME)  # type: ignore
# ---------------------------------------------------- #

# ---------------- API Routes ---------------- #
app = AppSyncResolver()
# -------------------------------------------- #


# Routes
@app.resolver(field_name="listExperiments")
@tracer.capture_method
def list_experiments() -> List[Dict[str, Any]]:
    """
    List experiments for the current user.
    Uses GSI byUserId.
    """
    logger.info("Listing experiments")

    # Get user ID from context
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Query by UserId using GSI
    try:
        response = EXPERIMENTS_TABLE.query(
            IndexName="byUserId", KeyConditionExpression=Key("UserId").eq(user_id)
        )
        experiments = response.get("Items", [])
    except ClientError as e:
        logger.exception(f"Error querying experiments: {str(e)}")
        raise ValueError(f"Failed to list experiments: {str(e)}")

    # Format response
    return [_format_experiment_response(exp) for exp in experiments]


@app.resolver(field_name="getExperiment")
@tracer.capture_method
def get_experiment(experimentId: str) -> Optional[Dict[str, Any]]:
    """
    Get a single experiment by ID.
    """
    logger.info(f"Getting experiment: {experimentId}")

    # Get user ID from context for authorization
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Get experiment from DynamoDB
    try:
        response = EXPERIMENTS_TABLE.get_item(
            Key={"ExperimentId": experimentId, "UserId": user_id}
        )
        experiment = response.get("Item")
    except ClientError as e:
        logger.exception(f"Error getting experiment: {str(e)}")
        raise ValueError(f"Failed to get experiment: {str(e)}")

    if not experiment:
        return None

    # Verify user has access to this experiment
    if experiment.get("UserId") != user_id:
        raise ValueError("Unauthorized access to experiment")

    return _format_experiment_response(experiment)


@app.resolver(field_name="createExperiment")
@tracer.capture_method
def create_experiment(
    name: str,
    description: Optional[str] = None,
    s3Path: Optional[str] = None,
    generationConfig: Optional[str] = None,
    modelId: str = "",
) -> str:
    """
    Create a new experiment and automatically trigger execution.
    Uses the dedicated experiments runtime for test case generation.
    Returns the experimentId.
    """
    logger.info(f"Creating experiment: {name}")

    # Get user ID from context
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Generate experiment ID
    import uuid

    experiment_id = str(uuid.uuid4())
    timestamp = datetime.now(timezone.utc).isoformat()

    # Parse generation config if provided
    generation_config = {}
    if generationConfig:
        generation_config = json.loads(generationConfig)

    # Create experiment item with RUNNING status
    experiment_item = {
        "ExperimentId": experiment_id,
        "UserId": user_id,
        "Name": name,
        "Status": "RUNNING",
        "CreatedAt": timestamp,
        "UpdatedAt": timestamp,
    }

    # Add optional fields
    if description:
        experiment_item["Description"] = description
    if s3Path:
        experiment_item["S3Path"] = s3Path
    experiment_item["ModelId"] = modelId

    # Add generation config fields
    if generation_config:
        if "context" in generation_config:
            experiment_item["Context"] = generation_config["context"]
        if "taskDescription" in generation_config:
            experiment_item["TaskDescription"] = generation_config["taskDescription"]
        if "numCases" in generation_config:
            experiment_item["NumCases"] = generation_config["numCases"]
        if "numTopics" in generation_config:
            experiment_item["NumTopics"] = generation_config["numTopics"]

    # Validate that generation config exists
    if not all(
        [
            experiment_item.get("Context"),
            experiment_item.get("TaskDescription"),
            experiment_item.get("NumCases"),
            experiment_item.get("NumTopics"),
            experiment_item.get("ModelId"),
        ]
    ):
        raise ValueError(
            "Experiment missing required generation config (context, taskDescription, numCases, numTopics, modelId)"
        )

    # Save to DynamoDB
    try:
        EXPERIMENTS_TABLE.put_item(Item=experiment_item)
    except ClientError as e:
        logger.exception(f"Error creating experiment: {str(e)}")
        raise ValueError(f"Failed to create experiment: {str(e)}")

    logger.info(f"Created experiment: {experiment_id}")
    logger.info(f"Auto-running experiment {experiment_id}")
    run_experiment(experimentId=experiment_id)

    return experiment_id


@app.resolver(field_name="updateExperiment")
@tracer.capture_method
def update_experiment(
    experimentId: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    status: Optional[str] = None,
) -> bool:
    """
    Update an existing experiment.
    Returns True if successful.
    """
    logger.info(f"Updating experiment: {experimentId}")

    # Get user ID from context for authorization
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Build update expression
    update_parts = []
    expression_attribute_names = {}
    expression_attribute_values = {":updatedAt": datetime.now(timezone.utc).isoformat()}

    update_parts.append("UpdatedAt = :updatedAt")

    if name:
        update_parts.append("#name = :name")
        expression_attribute_names["#name"] = "Name"
        expression_attribute_values[":name"] = name

    if description:
        update_parts.append("Description = :description")
        expression_attribute_values[":description"] = description

    if status:
        update_parts.append("#status = :status")
        expression_attribute_names["#status"] = "Status"
        expression_attribute_values[":status"] = status

    if not update_parts:
        return True  # Nothing to update

    update_expression = "SET " + ", ".join(update_parts)

    # Update in DynamoDB
    try:
        update_kwargs = {
            "Key": {"ExperimentId": experimentId, "UserId": user_id},
            "UpdateExpression": update_expression,
            "ExpressionAttributeValues": expression_attribute_values,
            "ConditionExpression": "UserId = :userId",
        }
        expression_attribute_values[":userId"] = user_id

        if expression_attribute_names:
            update_kwargs["ExpressionAttributeNames"] = expression_attribute_names

        EXPERIMENTS_TABLE.update_item(**update_kwargs)
    except ClientError as e:
        logger.exception(f"Error updating experiment: {str(e)}")
        raise ValueError(f"Failed to update experiment: {str(e)}")

    logger.info(f"Updated experiment: {experimentId}")
    return True


@app.resolver(field_name="deleteExperiment")
@tracer.capture_method
def delete_experiment(experimentId: str) -> Dict[str, Any]:
    """
    Delete an experiment.
    Returns deletion result.
    """
    logger.info(f"Deleting experiment: {experimentId}")

    # Get user ID from context for authorization
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Delete from DynamoDB
    try:
        EXPERIMENTS_TABLE.delete_item(
            Key={"ExperimentId": experimentId, "UserId": user_id},
            ConditionExpression="UserId = :userId",
            ExpressionAttributeValues={":userId": user_id},
        )
    except ClientError as e:
        logger.exception(f"Error deleting experiment: {str(e)}")
        raise ValueError(f"Failed to delete experiment: {str(e)}")

    logger.info(f"Deleted experiment: {experimentId}")
    return {"experimentId": experimentId, "deleted": True}


@app.resolver(field_name="runExperiment")
@tracer.capture_method
def run_experiment(experimentId: str) -> Dict[str, Any]:
    """
    Run experiment to generate synthetic test cases using AWS Batch.
    Submits a Batch job and returns immediately with RUNNING status.
    """
    logger.info(f"Running experiment: {experimentId}")

    # Get user ID from context for authorization
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    # Get experiment from DynamoDB
    try:
        response = EXPERIMENTS_TABLE.get_item(
            Key={"ExperimentId": experimentId, "UserId": user_id}
        )
        experiment = response.get("Item")
    except ClientError as e:
        logger.exception(f"Error getting experiment: {str(e)}")
        raise ValueError(f"Failed to get experiment: {str(e)}")

    if not experiment:
        raise ValueError(f"Experiment not found: {experimentId}")

    # Verify user has access to this experiment
    if experiment.get("UserId") != user_id:
        raise ValueError("Unauthorized access to experiment")

    # Validate that generation config exists
    if not all(
        [
            experiment.get("Context"),
            experiment.get("TaskDescription"),
            experiment.get("NumCases"),
            experiment.get("NumTopics"),
            experiment.get("ModelId"),
        ]
    ):
        raise ValueError(
            "Experiment missing required generation config (context, taskDescription, numCases, numTopics, modelId)"
        )

    # Submit AWS Batch job
    import boto3

    batch_client = boto3.client("batch")

    job_name = (
        f"experiment-{experimentId[:8]}-{int(datetime.now(timezone.utc).timestamp())}"
    )

    try:
        response = batch_client.submit_job(
            jobName=job_name,
            jobQueue=BATCH_JOB_QUEUE,
            jobDefinition=BATCH_JOB_DEFINITION,
            containerOverrides={
                "command": [
                    "python",
                    "batch_runner.py",
                ],
                "environment": [
                    {"name": "EXPERIMENT_ID", "value": experimentId},
                    {"name": "USER_ID", "value": user_id},
                ],
            },
        )

        batch_job_id = response["jobId"]
        logger.info(f"Submitted Batch job {batch_job_id} for experiment {experimentId}")

    except ClientError as e:
        logger.exception(f"Error submitting Batch job: {str(e)}")
        raise ValueError(f"Failed to submit Batch job: {str(e)}")

    # Update status to RUNNING with Batch job ID
    timestamp = datetime.now(timezone.utc).isoformat()
    try:
        EXPERIMENTS_TABLE.update_item(
            Key={"ExperimentId": experimentId, "UserId": user_id},
            UpdateExpression="SET #status = :status, UpdatedAt = :updatedAt, BatchJobId = :batchJobId",
            ExpressionAttributeNames={"#status": "Status"},
            ExpressionAttributeValues={
                ":status": "RUNNING",
                ":updatedAt": timestamp,
                ":batchJobId": batch_job_id,
                ":userId": user_id,
            },
            ConditionExpression="UserId = :userId",
        )
    except ClientError as e:
        logger.exception(f"Error updating experiment status: {str(e)}")
        raise ValueError(f"Failed to update experiment status: {str(e)}")

    # Return updated experiment
    experiment["Status"] = "RUNNING"
    experiment["UpdatedAt"] = timestamp
    experiment["BatchJobId"] = batch_job_id
    return _format_experiment_response(experiment)


# ---- S3 Presigned URL ---- #
S3_CLIENT = boto3.client("s3")
PRESIGNED_URL_EXPIRES_IN = int(os.environ.get("PRESIGNED_URL_EXPIRES_IN", 600))


@app.resolver(field_name="getExperimentPresignedUrl")
@tracer.capture_method
def get_experiment_presigned_url(s3Uri: str) -> Optional[str]:
    """
    Generate a presigned URL for accessing an S3 object in the evaluations bucket.

    Args:
        s3Uri: S3 URI in format s3://bucket-name/path/to/object

    Returns:
        Presigned URL string, or None on error
    """
    user_id = app.current_event.get("identity", {}).get("username")
    if not user_id:
        raise ValueError("User ID not found in request context")

    logger.info(f"Generating presigned URL for user {user_id}")

    parts = s3Uri.replace("s3://", "").split("/", 1)
    if len(parts) < 2:
        raise ValueError(f"Invalid S3 URI format: {s3Uri}")

    bucket_name = parts[0]
    object_key = parts[1]

    logger.info(f"Bucket: {bucket_name}, Key: {object_key}")

    url = S3_CLIENT.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket_name, "Key": object_key},
        ExpiresIn=PRESIGNED_URL_EXPIRES_IN,
    )
    logger.info(f"Generated presigned URL valid for {PRESIGNED_URL_EXPIRES_IN} seconds")
    return url


# Helpers
def _format_experiment_response(experiment: Dict[str, Any]) -> Dict[str, Any]:
    """
    Formats DynamoDB experiment item to GraphQL Experiment type.
    """
    return {
        "experimentId": experiment["ExperimentId"],
        "userId": experiment["UserId"],
        "name": experiment["Name"],
        "description": experiment.get("Description"),
        "createdAt": experiment["CreatedAt"],
        "updatedAt": experiment.get("UpdatedAt", experiment["CreatedAt"]),
        "status": experiment["Status"],
        "generatedCasesS3Url": experiment.get("GeneratedCasesS3Url"),
        "taskDescription": experiment.get("TaskDescription"),
        "context": experiment.get("Context"),
        "numCases": experiment.get("NumCases"),
        "numTopics": experiment.get("NumTopics"),
        "modelId": experiment.get("ModelId"),
        "generatedCasesCount": experiment.get("GeneratedCasesCount"),
        "errorMessage": experiment.get("ErrorMessage"),
        "batchJobId": experiment.get("BatchJobId"),
    }


# Handler
@logger.inject_lambda_context(
    log_event=False, correlation_id_path=correlation_paths.APPSYNC_RESOLVER
)
@tracer.capture_method
def handler(event: Dict, context: LambdaContext):
    try:
        # Otherwise, handle as AppSync resolver
        logger.info(
            "Incoming API request for Experiment related operation",
            extra={
                "payload": {
                    "fieldName": event.get("info", {}).get("fieldName"),
                    "arguments": event.get("arguments"),
                    "identity": event.get("identity"),
                }
            },
        )
        return app.resolve(event, context)
    except ValidationError as e:
        errors = e.errors(include_url=False, include_context=False, include_input=False)
        logger.warning("Validation error", errors=errors)
        raise ValueError(f"Invalid request. Details: {errors}")
    except Exception as e:
        logger.exception(e)
        raise RuntimeError("Something went wrong")
