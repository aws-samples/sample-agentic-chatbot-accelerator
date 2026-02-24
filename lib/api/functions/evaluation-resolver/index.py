# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Evaluation Resolver Lambda
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import AppSyncResolver
from aws_lambda_powertools.logging import correlation_paths
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="graphQL-evaluationResolver")
app = AppSyncResolver()
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
EVALUATIONS_TABLE_NAME = os.environ.get("EVALUATIONS_TABLE", "")
EVALUATIONS_BUCKET = os.environ.get("EVALUATIONS_BUCKET", "")
EVALUATION_QUEUE_URL = os.environ.get("EVALUATION_QUEUE_URL", "")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
DYNAMODB = boto3.resource("dynamodb")
EVALUATIONS_TABLE = DYNAMODB.Table(EVALUATIONS_TABLE_NAME) if EVALUATIONS_TABLE_NAME else None  # type: ignore
S3_CLIENT = boto3.client("s3")
SQS_CLIENT = boto3.client("sqs")
# ---------------------------------------------------------- #


# ===================== JSON Encoder ====================== #
class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles Decimal types from DynamoDB."""

    def default(self, obj):
        if isinstance(obj, Decimal):
            if obj % 1 == 0:
                return int(obj)
            return float(obj)
        return super().default(obj)


# ---------------------------------------------------------- #


# ========================= Queries ========================= #


@app.resolver(type_name="Query", field_name="listEvaluators")
def list_evaluators() -> list[dict]:
    """Retrieves all evaluators from DynamoDB.

    Returns:
        list[dict]: List of evaluator objects
    """
    if not EVALUATIONS_TABLE:
        logger.error("Evaluations table not configured")
        return []

    try:
        response = EVALUATIONS_TABLE.scan()
        items = response.get("Items", [])

        while "LastEvaluatedKey" in response:
            response = EVALUATIONS_TABLE.scan(
                ExclusiveStartKey=response["LastEvaluatedKey"]
            )
            items.extend(response.get("Items", []))

        logger.info("Retrieved evaluators", extra={"count": len(items)})
        return [_format_evaluator(item) for item in items]

    except ClientError as err:
        logger.error(
            "Scan operation failed",
            extra={"rawErrorMessage": str(err)},
        )
        return []


@app.resolver(type_name="Query", field_name="getEvaluator")
def get_evaluator(evaluatorId: str) -> Optional[dict]:
    """Get a single evaluator by ID.

    Args:
        evaluatorId (str): The unique identifier of the evaluator

    Returns:
        Optional[dict]: Evaluator object or None if not found
    """
    if not EVALUATIONS_TABLE or not evaluatorId:
        return None

    try:
        response = EVALUATIONS_TABLE.get_item(Key={"EvaluatorName": evaluatorId})
        item = response.get("Item")

        if item:
            return _format_evaluator(item, include_results=True)
        return None

    except ClientError as err:
        logger.error(
            f"Failed to get evaluator {evaluatorId}",
            extra={"rawErrorMessage": str(err)},
        )
        return None


# ========================= Mutations ========================= #


@app.resolver(type_name="Mutation", field_name="createEvaluator")
def create_evaluator(input: dict) -> Optional[dict]:
    """Creates a new evaluator.

    Args:
        input (dict): Input containing name, description, evaluatorType,
                     agentRuntimeId, qualifier, testCases, etc.

    Returns:
        Optional[dict]: Created evaluator object or None if failed
    """
    if not EVALUATIONS_TABLE or not input:
        logger.error("Invalid input or table not configured")
        return None

    # Use evaluator name as the primary key
    evaluator_name = input.get("name", "").strip()
    if not evaluator_name:
        logger.error("Evaluator name is required")
        return None
    timestamp = datetime.now(timezone.utc).isoformat()

    logger.info(
        "Creating new evaluator",
        extra={
            "evaluatorName": evaluator_name,
        },
    )

    # Parse and upload test cases to S3
    test_cases_json = input.get("testCases", "[]")
    try:
        test_cases = json.loads(test_cases_json)
        test_cases_count = len(test_cases)
    except json.JSONDecodeError as err:
        logger.error("Invalid test cases JSON", extra={"rawErrorMessage": str(err)})
        return None

    # Upload test cases to S3 (use sanitized name for S3 key)
    s3_key = f"evaluations/test-cases/{evaluator_name.lower().replace(' ', '-')}/test_cases.json"
    try:
        S3_CLIENT.put_object(
            Bucket=EVALUATIONS_BUCKET,
            Key=s3_key,
            Body=test_cases_json,
            ContentType="application/json",
        )
        logger.info(f"Uploaded test cases to s3://{EVALUATIONS_BUCKET}/{s3_key}")
    except ClientError as err:
        logger.error(
            "Failed to upload test cases to S3", extra={"rawErrorMessage": str(err)}
        )
        return None

    # Create evaluator record
    item = {
        "EvaluatorName": evaluator_name,
        "Description": input.get("description", ""),
        "EvaluatorType": input.get("evaluatorType"),
        "CustomRubric": input.get("customRubric", ""),
        "AgentRuntimeName": input.get("agentRuntimeName", ""),
        "Qualifier": input.get("qualifier"),
        "ModelId": input.get("modelId"),
        "PassThreshold": Decimal(str(input.get("passThreshold"))),
        "TestCasesS3Path": f"s3://{EVALUATIONS_BUCKET}/{s3_key}",
        "TestCasesCount": test_cases_count,
        "Status": "Created",
        # Run fields - initially empty/null
        "PassedCases": 0,
        "FailedCases": 0,
        "CreatedAt": timestamp,
    }

    try:
        EVALUATIONS_TABLE.put_item(Item=item)
        logger.info(f"Created evaluator {evaluator_name}")
        return _format_evaluator(item)

    except ClientError as err:
        logger.error("Failed to create evaluator", extra={"rawErrorMessage": str(err)})
        return None


@app.resolver(type_name="Mutation", field_name="deleteEvaluator")
def delete_evaluator(evaluatorId: str) -> bool:
    """Delete an evaluator.

    Args:
        evaluatorId (str): The unique identifier of the evaluator to delete

    Returns:
        bool: True if deleted successfully, False otherwise
    """
    if not EVALUATIONS_TABLE or not evaluatorId:
        return False

    logger.info(f"Deleting evaluator {evaluatorId}")

    # Get the evaluator to find S3 path
    evaluator = get_evaluator(evaluatorId)
    if not evaluator:
        logger.error(f"Evaluator {evaluatorId} not found")
        return False

    # Delete test cases from S3
    s3_path = evaluator.get("testCasesS3Path", "")
    if s3_path:
        try:
            bucket, key = _parse_s3_uri(s3_path)
            S3_CLIENT.delete_object(Bucket=bucket, Key=key)
            logger.info(f"Deleted test cases from S3: {s3_path}")
        except (ClientError, ValueError) as err:
            logger.error(
                "Failed to delete test cases S3 object",
                extra={"rawErrorMessage": str(err)},
            )

    # Delete results folder from S3 (includes individual test case results and aggregated results)
    _delete_results_folder(evaluatorId)

    # Delete the evaluator
    try:
        EVALUATIONS_TABLE.delete_item(Key={"EvaluatorName": evaluatorId})
        logger.info(f"Deleted evaluator {evaluatorId}")
        return True

    except ClientError as err:
        logger.error("Failed to delete evaluator", extra={"rawErrorMessage": str(err)})
        return False


def _delete_results_folder(evaluator_id: str) -> None:
    """Delete all result files for an evaluator from S3.

    Deletes all objects under the evaluations/results/{evaluator_id}/ prefix.

    Args:
        evaluator_id: The evaluator ID
    """
    if not EVALUATIONS_BUCKET:
        return

    prefix = f"evaluations/results/{evaluator_id}/"

    try:
        # List all objects with the prefix
        paginator = S3_CLIENT.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=EVALUATIONS_BUCKET, Prefix=prefix)

        objects_to_delete = []
        for page in pages:
            for obj in page.get("Contents", []):
                objects_to_delete.append({"Key": obj["Key"]})

        if not objects_to_delete:
            logger.info(f"No results to delete for evaluator {evaluator_id}")
            return

        # Delete objects in batches (max 1000 per request)
        for i in range(0, len(objects_to_delete), 1000):
            batch = objects_to_delete[i : i + 1000]
            S3_CLIENT.delete_objects(
                Bucket=EVALUATIONS_BUCKET,
                Delete={"Objects": batch},
            )

        logger.info(
            f"Deleted {len(objects_to_delete)} result files for evaluator {evaluator_id}"
        )

    except ClientError as err:
        logger.error(
            f"Failed to delete results folder for evaluator {evaluator_id}",
            extra={"rawErrorMessage": str(err)},
        )


@app.resolver(type_name="Mutation", field_name="runEvaluation")
def run_evaluation(evaluatorId: str) -> Optional[dict]:
    """Start running an evaluation by sending test cases to SQS queue.

    Flow:
        1. User calls runEvaluation via AppSync/GraphQL
        2. This function updates status to "Running" in DynamoDB
        3. This function sends each test case as an SQS message
        4. This function returns immediately to user with status="Running"
        5. EvaluationExecutor Lambda processes test cases in parallel (up to maxConcurrency)
        6. Each test case result is written to S3 and progress updated in DynamoDB
        7. User polls getEvaluator to check for completion

    Sequence Diagram:
        User → AppSync → run_evaluation() → returns status="Running" (fast, <1s)
                              │
                              └──→ SQS Queue (one message per test case)
                                        │
                                        └──→ EvaluationExecutor Lambda (parallel, throttled)
                                                  │
                                                  └──→ S3 + DynamoDB (incremental results)


    Args:
        evaluatorId (str): The unique identifier of the evaluator to run

    Returns:
        Optional[dict]: Updated evaluator object with status="Running",
                       or None if validation/update failed
    """
    if not EVALUATIONS_TABLE or not evaluatorId:
        return None

    logger.info(f"Starting evaluation {evaluatorId}")

    # Get the evaluator
    evaluator = get_evaluator(evaluatorId)
    if not evaluator:
        logger.error(f"Evaluator {evaluatorId} not found")
        return None

    if evaluator.get("status") not in ["Created", "Failed"]:
        logger.error(f"Evaluation cannot be run, status: {evaluator.get('status')}")
        return None

    # Load test cases from S3
    test_cases = _load_test_cases(evaluator.get("testCasesS3Path"))
    if not test_cases:
        logger.error(f"No test cases found for evaluator {evaluatorId}")
        return None

    # Update status to Running with total count and reset counters
    timestamp = datetime.now(timezone.utc).isoformat()

    try:
        EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluatorId},
            UpdateExpression="""SET #s = :status, StartedAt = :started,
                               TotalCases = :total, CompletedCases = :zero,
                               PassedCases = :zero, FailedCases = :zero""",
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Running",
                ":started": timestamp,
                ":total": len(test_cases),
                ":zero": 0,
            },
        )
        logger.info(
            f"Updated evaluator {evaluatorId} to Running with {len(test_cases)} test cases"
        )

    except ClientError as err:
        logger.error(
            "Failed to update evaluator status", extra={"rawErrorMessage": str(err)}
        )
        return None

    # Send each test case to SQS queue
    if not EVALUATION_QUEUE_URL:
        logger.error("EVALUATION_QUEUE_URL not configured")
        _update_evaluator_failed(evaluatorId, "Queue URL not configured")
        return None

    try:
        for i, test_case in enumerate(test_cases):
            message = {
                "evaluatorId": evaluatorId,
                "testCaseIndex": i,
                "testCase": test_case,
                "evaluatorConfig": {
                    "evaluatorType": evaluator.get("evaluatorType"),
                    "agentRuntimeName": evaluator.get("agentRuntimeName"),
                    "qualifier": evaluator.get("qualifier"),
                    "customRubric": evaluator.get("customRubric"),
                    "modelId": evaluator.get("modelId"),
                    "passThreshold": evaluator.get("passThreshold"),
                },
            }

            SQS_CLIENT.send_message(
                QueueUrl=EVALUATION_QUEUE_URL,
                MessageBody=json.dumps(message, cls=DecimalEncoder),
                MessageAttributes={
                    "EvaluatorId": {
                        "StringValue": evaluatorId,
                        "DataType": "String",
                    },
                    "TestCaseIndex": {
                        "StringValue": str(i),
                        "DataType": "Number",
                    },
                },
            )

        logger.info(
            f"Sent {len(test_cases)} test cases to SQS queue",
            extra={
                "evaluatorId": evaluatorId,
                "testCaseCount": len(test_cases),
                "queueUrl": EVALUATION_QUEUE_URL,
            },
        )

    except ClientError as err:
        logger.error(
            "Failed to send test cases to SQS", extra={"rawErrorMessage": str(err)}
        )
        _update_evaluator_failed(evaluatorId, f"Failed to queue test cases: {str(err)}")
        return None

    # Return the updated evaluator
    return get_evaluator(evaluatorId)


@tracer.capture_method
def _load_test_cases(s3_path: str) -> list[dict]:
    """Load test cases from S3."""
    if not s3_path or not s3_path.startswith("s3://"):
        return []

    try:
        bucket, key = _parse_s3_uri(s3_path)
        response = S3_CLIENT.get_object(Bucket=bucket, Key=key)
        content = response["Body"].read().decode("utf-8")
        return json.loads(content)
    except (ClientError, json.JSONDecodeError) as err:
        logger.error(f"Failed to load test cases: {err}")
        return []


def _update_evaluator_failed(evaluator_id: str, error_message: str) -> None:
    """Update evaluator as failed."""
    if not EVALUATIONS_TABLE:
        return
    timestamp = datetime.now(timezone.utc).isoformat()
    try:
        EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluator_id},
            UpdateExpression="SET #s = :status, ErrorMessage = :error, CompletedAt = :completed",
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Failed",
                ":error": error_message,
                ":completed": timestamp,
            },
        )
    except ClientError as err:
        logger.error(f"Failed to update evaluator status: {err}")


# ========================= Helpers ========================= #


def _format_evaluator(item: dict, include_results: bool = False) -> dict:
    """Format DynamoDB item to GraphQL Evaluator type.

    Args:
        item (dict): DynamoDB item
        include_results (bool): If True, load results from S3. Default False for list operations.
    """
    results = []
    results_s3_path = item.get("ResultsS3Path", "")

    # Load results from S3 only when requested (for getEvaluator, not listEvaluators)
    if include_results and results_s3_path:
        results = _load_results_from_s3(results_s3_path)

    # EvaluatorName is now the primary key (also used as evaluatorId in GraphQL)
    evaluator_name = item.get("EvaluatorName", "")

    return {
        "evaluatorId": evaluator_name,
        "name": evaluator_name,
        "description": item.get("Description"),
        "evaluatorType": item.get("EvaluatorType"),
        "customRubric": item.get("CustomRubric"),
        "agentRuntimeName": item.get("AgentRuntimeName"),
        "qualifier": item.get("Qualifier"),
        "modelId": item.get("ModelId"),
        "passThreshold": float(item.get("PassThreshold"))
        if item.get("PassThreshold") is not None
        else None,
        "testCasesS3Path": item.get("TestCasesS3Path"),
        "testCasesCount": item.get("TestCasesCount", 0),
        "resultsS3Path": results_s3_path,
        "status": item.get("Status"),
        "passedCases": item.get("PassedCases", 0),
        "failedCases": item.get("FailedCases", 0),
        "totalTimeMs": item.get("TotalTimeMs"),
        "results": [_format_evaluation_result(r) for r in results] if results else [],
        "errorMessage": item.get("ErrorMessage"),
        "createdAt": item.get("CreatedAt"),
        "startedAt": item.get("StartedAt"),
        "completedAt": item.get("CompletedAt"),
    }


def _load_results_from_s3(s3_path: str) -> list[dict]:
    """Load evaluation results from S3.

    Args:
        s3_path (str): S3 URI to results file

    Returns:
        list[dict]: List of evaluation results
    """
    if not s3_path or not s3_path.startswith("s3://"):
        return []

    try:
        bucket, key = _parse_s3_uri(s3_path)
        response = S3_CLIENT.get_object(Bucket=bucket, Key=key)
        content = response["Body"].read().decode("utf-8")
        data = json.loads(content)
        return data.get("results", [])
    except (ClientError, json.JSONDecodeError) as err:
        logger.error(f"Failed to load results from S3: {err}")
        return []


def _format_evaluation_result(result: dict) -> dict:
    """Format evaluation result."""
    score = result.get("score", 0)
    # Use 80% threshold for passed to align with UI display
    # This ensures backward compatibility with old results that may have
    # different passed values based on Strands evaluator's internal logic
    passed = (
        score >= 80 if isinstance(score, (int, float)) else result.get("passed", False)
    )
    return {
        "caseName": result.get("caseName") or result.get("case_name"),
        "input": result.get("input"),
        "expectedOutput": result.get("expectedOutput") or result.get("expected_output"),
        "actualOutput": result.get("actualOutput") or result.get("actual_output"),
        "score": score,
        "passed": passed,
        "reason": result.get("reason"),
        "latencyMs": result.get("latencyMs") or result.get("latency_ms"),
    }


def _parse_s3_uri(s3_uri: str) -> tuple[str, str]:
    """Parse S3 URI into bucket and key."""
    if not s3_uri.startswith("s3://"):
        raise ValueError(f"Invalid S3 URI: {s3_uri}")

    path = s3_uri[5:]
    parts = path.split("/", 1)

    if len(parts) != 2:
        raise ValueError(f"Invalid S3 URI: {s3_uri}")

    return parts[0], parts[1]


# ========================= Handler ========================= #


@logger.inject_lambda_context(correlation_id_path=correlation_paths.APPSYNC_RESOLVER)
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext):
    """Lambda handler for AppSync resolver operations."""
    return app.resolve(event, context)
