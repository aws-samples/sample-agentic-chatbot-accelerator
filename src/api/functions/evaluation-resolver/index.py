# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Evaluation Resolver Lambda.

Handles two concerns split across two DynamoDB tables:

- Evaluators (config): the reusable definition of what to test and how.
  Stored in EVALUATIONS_TABLE keyed by EvaluatorName.
- Evaluator runs (executions): one item per run, snapshotting the evaluator
  config used. Stored in EVALUATOR_RUNS_TABLE keyed by (EvaluatorId, RunId).

Starting a run creates a run record and fans test cases out to SQS; the
evaluation executor writes progress/results back to the runs table.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import AppSyncResolver
from aws_lambda_powertools.logging import correlation_paths
from boto3.dynamodb.conditions import Key
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
EVALUATOR_RUNS_TABLE_NAME = os.environ.get("EVALUATOR_RUNS_TABLE", "")
EVALUATIONS_BUCKET = os.environ.get("EVALUATIONS_BUCKET", "")
EVALUATION_QUEUE_URL = os.environ.get("EVALUATION_QUEUE_URL", "")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
DYNAMODB = boto3.resource("dynamodb")
EVALUATIONS_TABLE = (
    DYNAMODB.Table(EVALUATIONS_TABLE_NAME) if EVALUATIONS_TABLE_NAME else None
)  # type: ignore
EVALUATOR_RUNS_TABLE = (
    DYNAMODB.Table(EVALUATOR_RUNS_TABLE_NAME) if EVALUATOR_RUNS_TABLE_NAME else None  # type: ignore
)
S3_CLIENT = boto3.client("s3")
SQS_CLIENT = boto3.client("sqs")
# Control-plane client used to resolve the concrete AgentCore runtime version
# for a (runtime name, qualifier) pair when a run starts. Version resolution is
# best-effort: failures never block run creation.
AGENTCORE_CONTROL_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# Crockford base32 alphabet for ULID encoding.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


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


def _generate_run_id() -> str:
    """Generate a lexicographically sortable ULID-style run id.

    48-bit millisecond timestamp + 80 bits of randomness, Crockford base32
    encoded (26 chars). Sortable by creation time, so the runs table sort key
    naturally orders run history chronologically.
    """
    timestamp_ms = int(time.time() * 1000)
    rand = secrets.randbits(80)
    value = (timestamp_ms << 80) | rand

    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "run-" + "".join(reversed(chars))


# ========================= Queries ========================= #


@app.resolver(type_name="Query", field_name="listEvaluators")
def list_evaluators() -> list[dict]:
    """Retrieve all evaluator configs from DynamoDB."""
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
        logger.error("Scan operation failed", extra={"rawErrorMessage": str(err)})
        return []


@app.resolver(type_name="Query", field_name="getEvaluator")
def get_evaluator(evaluatorId: str) -> Optional[dict]:
    """Get a single evaluator config by ID."""
    item = _get_evaluator_item(evaluatorId)
    return _format_evaluator(item, include_run_detail=True) if item else None


@app.resolver(type_name="Query", field_name="listEvaluatorRuns")
def list_evaluator_runs(evaluatorId: str) -> list[dict]:
    """List all runs for an evaluator, newest first."""
    if not EVALUATOR_RUNS_TABLE or not evaluatorId:
        return []

    try:
        response = EVALUATOR_RUNS_TABLE.query(
            KeyConditionExpression=Key("EvaluatorId").eq(evaluatorId),
            ScanIndexForward=False,  # newest run first (RunId is time-sortable)
        )
        items = response.get("Items", [])

        while "LastEvaluatedKey" in response:
            response = EVALUATOR_RUNS_TABLE.query(
                KeyConditionExpression=Key("EvaluatorId").eq(evaluatorId),
                ScanIndexForward=False,
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))

        return [_format_run(item, include_results=False) for item in items]

    except ClientError as err:
        logger.error("Failed to list runs", extra={"rawErrorMessage": str(err)})
        return []


@app.resolver(type_name="Query", field_name="getEvaluatorRun")
def get_evaluator_run(evaluatorId: str, runId: str) -> Optional[dict]:
    """Get a single run (with results loaded from S3)."""
    item = _get_run_item(evaluatorId, runId)
    return _format_run(item, include_results=True) if item else None


@app.resolver(type_name="Query", field_name="getEvaluatorTestCases")
def get_evaluator_test_cases(evaluatorId: str) -> Optional[str]:
    """Return the raw test-case JSON for an evaluator (for the edit form)."""
    item = _get_evaluator_item(evaluatorId)
    if not item:
        return None
    test_cases = _load_test_cases(item.get("TestCasesS3Path"))
    return json.dumps(test_cases)


# ========================= Mutations ========================= #


@app.resolver(type_name="Mutation", field_name="createEvaluator")
def create_evaluator(input: dict) -> Optional[dict]:
    """Create a new evaluator config (no run state)."""
    if not EVALUATIONS_TABLE or not input:
        logger.error("Invalid input or table not configured")
        return None

    evaluator_name = input.get("name", "").strip()
    if not evaluator_name:
        logger.error("Evaluator name is required")
        return None

    timestamp = datetime.now(timezone.utc).isoformat()
    logger.info("Creating new evaluator", extra={"evaluatorName": evaluator_name})

    # Parse and upload test cases to S3
    test_cases_json = input.get("testCases", "[]")
    try:
        test_cases = json.loads(test_cases_json)
        test_cases_count = len(test_cases)
    except json.JSONDecodeError as err:
        logger.error("Invalid test cases JSON", extra={"rawErrorMessage": str(err)})
        return None

    s3_key = _test_cases_key(evaluator_name)
    try:
        S3_CLIENT.put_object(
            Bucket=EVALUATIONS_BUCKET,
            Key=s3_key,
            Body=test_cases_json,
            ContentType="application/json",
        )
    except ClientError as err:
        logger.error("Failed to upload test cases", extra={"rawErrorMessage": str(err)})
        return None

    item = {
        "EvaluatorName": evaluator_name,
        "Description": input.get("description", ""),
        "EvaluatorType": input.get("evaluatorType"),
        "CustomRubric": input.get("customRubric", ""),
        "AgentRuntimeName": input.get("agentRuntimeName", ""),
        "Qualifier": input.get("qualifier"),
        "ModelId": input.get("modelId"),
        "PassThreshold": Decimal(str(input.get("passThreshold"))),
        "RepeatCount": int(input.get("repeatCount") or 1),
        "TestCasesS3Path": f"s3://{EVALUATIONS_BUCKET}/{s3_key}",
        "TestCasesCount": test_cases_count,
        "CreatedAt": timestamp,
    }

    try:
        EVALUATIONS_TABLE.put_item(Item=item)
        logger.info(f"Created evaluator {evaluator_name}")
        return _format_evaluator(item)
    except ClientError as err:
        logger.error("Failed to create evaluator", extra={"rawErrorMessage": str(err)})
        return None


@app.resolver(type_name="Mutation", field_name="updateEvaluator")
def update_evaluator(evaluatorId: str, input: dict) -> Optional[dict]:
    """Update an evaluator config in place (does not affect past runs)."""
    if not EVALUATIONS_TABLE or not evaluatorId:
        return None

    item = _get_evaluator_item(evaluatorId)
    if not item:
        logger.error(f"Evaluator {evaluatorId} not found")
        return None

    # Map GraphQL input fields to DynamoDB attributes.
    field_map = {
        "description": "Description",
        "evaluatorType": "EvaluatorType",
        "customRubric": "CustomRubric",
        "agentRuntimeName": "AgentRuntimeName",
        "qualifier": "Qualifier",
        "modelId": "ModelId",
    }

    updates: dict = {}
    for gql_field, attr in field_map.items():
        if input.get(gql_field) is not None:
            updates[attr] = input[gql_field]

    if input.get("passThreshold") is not None:
        updates["PassThreshold"] = Decimal(str(input["passThreshold"]))

    if input.get("repeatCount") is not None:
        updates["RepeatCount"] = int(input["repeatCount"])

    # Re-upload test cases if provided.
    if input.get("testCases") is not None:
        try:
            test_cases = json.loads(input["testCases"])
        except json.JSONDecodeError as err:
            logger.error("Invalid test cases JSON", extra={"rawErrorMessage": str(err)})
            return None
        s3_key = _test_cases_key(evaluatorId)
        S3_CLIENT.put_object(
            Bucket=EVALUATIONS_BUCKET,
            Key=s3_key,
            Body=input["testCases"],
            ContentType="application/json",
        )
        updates["TestCasesS3Path"] = f"s3://{EVALUATIONS_BUCKET}/{s3_key}"
        updates["TestCasesCount"] = len(test_cases)

    if not updates:
        return _format_evaluator(item)

    updates["UpdatedAt"] = datetime.now(timezone.utc).isoformat()

    set_expr = ", ".join(f"#{a} = :{a}" for a in updates)
    expr_names = {f"#{a}": a for a in updates}
    expr_values = {f":{a}": v for a, v in updates.items()}

    try:
        response = EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluatorId},
            UpdateExpression=f"SET {set_expr}",
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues="ALL_NEW",
        )
        return _format_evaluator(response.get("Attributes", {}))
    except ClientError as err:
        logger.error("Failed to update evaluator", extra={"rawErrorMessage": str(err)})
        return None


@app.resolver(type_name="Mutation", field_name="deleteEvaluator")
def delete_evaluator(evaluatorId: str) -> bool:
    """Delete an evaluator config and cascade-delete all of its runs."""
    if not EVALUATIONS_TABLE or not evaluatorId:
        return False

    logger.info(f"Deleting evaluator {evaluatorId}")

    item = _get_evaluator_item(evaluatorId)
    if not item:
        logger.error(f"Evaluator {evaluatorId} not found")
        return False

    # Delete test cases from S3
    s3_path = item.get("TestCasesS3Path", "")
    if s3_path:
        try:
            bucket, key = _parse_s3_uri(s3_path)
            S3_CLIENT.delete_object(Bucket=bucket, Key=key)
        except (ClientError, ValueError) as err:
            logger.error(
                "Failed to delete test cases", extra={"rawErrorMessage": str(err)}
            )

    # Cascade-delete all runs (records + their S3 results)
    _delete_all_runs(evaluatorId)

    try:
        EVALUATIONS_TABLE.delete_item(Key={"EvaluatorName": evaluatorId})
        logger.info(f"Deleted evaluator {evaluatorId}")
        return True
    except ClientError as err:
        logger.error("Failed to delete evaluator", extra={"rawErrorMessage": str(err)})
        return False


@app.resolver(type_name="Mutation", field_name="deleteEvaluatorRun")
def delete_evaluator_run(evaluatorId: str, runId: str) -> bool:
    """Delete a single run record and its S3 results."""
    if not EVALUATOR_RUNS_TABLE or not evaluatorId or not runId:
        return False

    _delete_results_folder(evaluatorId, runId)

    try:
        EVALUATOR_RUNS_TABLE.delete_item(
            Key={"EvaluatorId": evaluatorId, "RunId": runId}
        )
        logger.info(f"Deleted run {runId} for evaluator {evaluatorId}")
        return True
    except ClientError as err:
        logger.error("Failed to delete run", extra={"rawErrorMessage": str(err)})
        return False


@app.resolver(type_name="Mutation", field_name="startEvaluatorRun")
def start_evaluator_run(evaluatorId: str) -> Optional[dict]:
    """Start a new run: snapshot config, create a run record, queue test cases.

    Each call creates a NEW run record, so re-running keeps full history.
    """
    if not EVALUATIONS_TABLE or not EVALUATOR_RUNS_TABLE or not evaluatorId:
        return None

    evaluator = _get_evaluator_item(evaluatorId)
    if not evaluator:
        logger.error(f"Evaluator {evaluatorId} not found")
        return None

    test_cases = _load_test_cases(evaluator.get("TestCasesS3Path"))
    if not test_cases:
        logger.error(f"No test cases found for evaluator {evaluatorId}")
        return None

    run_id = _generate_run_id()
    timestamp = datetime.now(timezone.utc).isoformat()

    repeat_count = int(evaluator.get("RepeatCount") or 1)
    total_units = len(test_cases) * repeat_count

    agent_runtime_name = evaluator.get("AgentRuntimeName", "")
    qualifier = evaluator.get("Qualifier")
    # Resolve and snapshot the concrete AgentCore version this run targets so
    # run history stays historically accurate even if the qualifier is later
    # re-tagged to a different version. Best-effort: None when unresolvable.
    runtime_version = _resolve_runtime_version(agent_runtime_name, qualifier)

    # Snapshot the evaluator config into the run so history stays accurate
    # even if the evaluator is later edited or deleted.
    run_item = {
        "EvaluatorId": evaluatorId,
        "RunId": run_id,
        "EvaluatorName": evaluator.get("EvaluatorName"),
        "EvaluatorType": evaluator.get("EvaluatorType"),
        "CustomRubric": evaluator.get("CustomRubric", ""),
        "AgentRuntimeName": agent_runtime_name,
        "Qualifier": qualifier,
        "ModelId": evaluator.get("ModelId"),
        "PassThreshold": evaluator.get("PassThreshold"),
        "RepeatCount": repeat_count,
        "TestCasesS3Path": evaluator.get("TestCasesS3Path"),
        "TestCasesCount": evaluator.get("TestCasesCount", len(test_cases)),
        "Status": "Running",
        "TotalCases": len(test_cases),
        # Units = individual (case, repetition) executions. Completion and the
        # per-case aggregation are tracked at the unit level.
        "TotalUnits": total_units,
        "CompletedUnits": 0,
        "CompletedCases": 0,
        "PassedCases": 0,
        "FailedCases": 0,
        "CreatedAt": timestamp,
        "StartedAt": timestamp,
    }

    # Only persist the version when it resolved; leaving it absent keeps the
    # attribute optional and avoids storing an empty value for older/unresolved
    # runtimes (DynamoDB cannot store None).
    if runtime_version:
        run_item["RuntimeVersion"] = runtime_version

    try:
        EVALUATOR_RUNS_TABLE.put_item(Item=run_item)
    except ClientError as err:
        logger.error("Failed to create run record", extra={"rawErrorMessage": str(err)})
        return None

    # Update the evaluator's denormalized "last run" pointer for the list view.
    _update_last_run_pointer(
        evaluatorId, run_id, "Running", timestamp, passed=0, failed=0
    )

    if not EVALUATION_QUEUE_URL:
        logger.error("EVALUATION_QUEUE_URL not configured")
        _mark_run_failed(evaluatorId, run_id, "Queue URL not configured")
        return _format_run(_get_run_item(evaluatorId, run_id))

    try:
        for i, test_case in enumerate(test_cases):
            for repeat_index in range(repeat_count):
                message = {
                    "evaluatorId": evaluatorId,
                    "runId": run_id,
                    "testCaseIndex": i,
                    "repeatIndex": repeat_index,
                    "testCase": test_case,
                    "evaluatorConfig": {
                        "evaluatorType": evaluator.get("EvaluatorType"),
                        "agentRuntimeName": evaluator.get("AgentRuntimeName"),
                        "qualifier": evaluator.get("Qualifier"),
                        "customRubric": evaluator.get("CustomRubric"),
                        "modelId": evaluator.get("ModelId"),
                        "passThreshold": evaluator.get("PassThreshold"),
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
                        "RunId": {"StringValue": run_id, "DataType": "String"},
                        "TestCaseIndex": {"StringValue": str(i), "DataType": "Number"},
                        "RepeatIndex": {
                            "StringValue": str(repeat_index),
                            "DataType": "Number",
                        },
                    },
                )

        logger.info(
            f"Queued {total_units} units ({len(test_cases)} cases × {repeat_count}) "
            f"for run {run_id}",
            extra={"evaluatorId": evaluatorId, "runId": run_id},
        )
    except ClientError as err:
        logger.error("Failed to queue test cases", extra={"rawErrorMessage": str(err)})
        _mark_run_failed(evaluatorId, run_id, f"Failed to queue test cases: {err}")
        return _format_run(_get_run_item(evaluatorId, run_id))

    return _format_run(_get_run_item(evaluatorId, run_id))


@app.resolver(type_name="Mutation", field_name="runEvaluation")
def run_evaluation(evaluatorId: str) -> Optional[dict]:
    """Deprecated alias of startEvaluatorRun.

    Starts a new run (identical behaviour to startEvaluatorRun) but returns the
    Evaluator shape with its last-run state populated, matching the pre-split
    API so older clients keep working.
    """
    run = start_evaluator_run(evaluatorId)
    if run is None:
        return None
    # Return the evaluator, whose last-run pointer now reflects the run we
    # just started; the deprecated compat fields on Evaluator surface its state.
    item = _get_evaluator_item(evaluatorId)
    return _format_evaluator(item, include_run_detail=True) if item else None


# ========================= Internal helpers ========================= #


def _get_evaluator_item(evaluator_id: str) -> Optional[dict]:
    if not EVALUATIONS_TABLE or not evaluator_id:
        return None
    try:
        return EVALUATIONS_TABLE.get_item(Key={"EvaluatorName": evaluator_id}).get(
            "Item"
        )
    except ClientError as err:
        logger.error("Failed to get evaluator", extra={"rawErrorMessage": str(err)})
        return None


def _get_run_item(evaluator_id: str, run_id: str) -> Optional[dict]:
    if not EVALUATOR_RUNS_TABLE or not evaluator_id or not run_id:
        return None
    try:
        return EVALUATOR_RUNS_TABLE.get_item(
            Key={"EvaluatorId": evaluator_id, "RunId": run_id}
        ).get("Item")
    except ClientError as err:
        logger.error("Failed to get run", extra={"rawErrorMessage": str(err)})
        return None


def _resolve_runtime_version(
    agent_runtime_name: str, qualifier: Optional[str]
) -> Optional[str]:
    """Resolve the concrete AgentCore version for a (runtime name, qualifier).

    Mirrors the executor's resolution path: list runtimes to map the runtime
    name to its id, then read the endpoint (qualifier) to get the concrete
    version it currently points at.

    Best-effort by design: any failure (missing config, unknown runtime/
    qualifier, missing IAM permission, or unexpected API shape) returns None so
    a run can still start. The version is provenance metadata, not a
    precondition for running.

    Args:
        agent_runtime_name: The agent runtime name snapshotted on the run.
        qualifier: The endpoint/qualifier (e.g. "DEFAULT"). Defaults to
            "DEFAULT" when absent.

    Returns:
        The concrete version string (e.g. "7") or None if it cannot be
        resolved.
    """
    if not agent_runtime_name:
        return None

    endpoint_name = qualifier or "DEFAULT"

    try:
        runtime_id = _find_agent_runtime_id(agent_runtime_name)
        if not runtime_id:
            logger.warning(
                "Could not resolve runtime id for version lookup",
                extra={"agentRuntimeName": agent_runtime_name},
            )
            return None

        response = AGENTCORE_CONTROL_CLIENT.get_agent_runtime_endpoint(
            agentRuntimeId=runtime_id, endpointName=endpoint_name
        )
        # The endpoint reports the version it currently serves. Prefer the live
        # version, falling back to the target version when a deployment is in
        # progress.
        version = response.get("liveVersion") or response.get("targetVersion")
        if version is None:
            return None
        return str(version)
    except (ClientError, KeyError) as err:
        logger.warning(
            "Failed to resolve runtime version; leaving it unset",
            extra={
                "agentRuntimeName": agent_runtime_name,
                "qualifier": endpoint_name,
                "rawErrorMessage": str(err),
            },
        )
        return None


def _find_agent_runtime_id(agent_runtime_name: str) -> Optional[str]:
    """Map an agent runtime name to its runtime id via the control plane.

    Paginates ListAgentRuntimes and returns the id of the first runtime whose
    name matches. Returns None when no match is found.
    """
    next_token = None
    while True:
        api_arguments: dict = {"maxResults": 10}
        if next_token:
            api_arguments["nextToken"] = next_token

        response = AGENTCORE_CONTROL_CLIENT.list_agent_runtimes(**api_arguments)
        for elem in response.get("agentRuntimes", []):
            if elem.get("agentRuntimeName") == agent_runtime_name:
                return elem.get("agentRuntimeId")

        next_token = response.get("nextToken")
        if not next_token:
            return None


def _test_cases_key(evaluator_name: str) -> str:
    safe = evaluator_name.lower().replace(" ", "-")
    return f"evaluations/test-cases/{safe}/test_cases.json"


def _update_last_run_pointer(
    evaluator_id: str,
    run_id: str,
    status: str,
    timestamp: str,
    passed: int,
    failed: int,
) -> None:
    """Update the evaluator's denormalized last-run summary."""
    if not EVALUATIONS_TABLE:
        return
    try:
        EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluator_id},
            UpdateExpression=(
                "SET LastRunId = :rid, LastRunStatus = :st, LastRunAt = :ts, "
                "LastRunPassedCases = :p, LastRunFailedCases = :f"
            ),
            ExpressionAttributeValues={
                ":rid": run_id,
                ":st": status,
                ":ts": timestamp,
                ":p": passed,
                ":f": failed,
            },
        )
    except ClientError as err:
        logger.warning(f"Failed to update last-run pointer: {err}")


def _mark_run_failed(evaluator_id: str, run_id: str, error_message: str) -> None:
    if not EVALUATOR_RUNS_TABLE:
        return
    timestamp = datetime.now(timezone.utc).isoformat()
    try:
        EVALUATOR_RUNS_TABLE.update_item(
            Key={"EvaluatorId": evaluator_id, "RunId": run_id},
            UpdateExpression="SET #s = :status, ErrorMessage = :error, CompletedAt = :c",
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Failed",
                ":error": error_message,
                ":c": timestamp,
            },
        )
    except ClientError as err:
        logger.error(f"Failed to mark run failed: {err}")
    _update_last_run_pointer(evaluator_id, run_id, "Failed", timestamp, 0, 0)


def _delete_all_runs(evaluator_id: str) -> None:
    """Delete every run record (and its S3 results) for an evaluator."""
    if not EVALUATOR_RUNS_TABLE:
        return
    try:
        response = EVALUATOR_RUNS_TABLE.query(
            KeyConditionExpression=Key("EvaluatorId").eq(evaluator_id)
        )
        items = response.get("Items", [])
        while "LastEvaluatedKey" in response:
            response = EVALUATOR_RUNS_TABLE.query(
                KeyConditionExpression=Key("EvaluatorId").eq(evaluator_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))

        for run in items:
            run_id = run.get("RunId")
            _delete_results_folder(evaluator_id, run_id)
            EVALUATOR_RUNS_TABLE.delete_item(
                Key={"EvaluatorId": evaluator_id, "RunId": run_id}
            )
        logger.info(f"Deleted {len(items)} runs for evaluator {evaluator_id}")
    except ClientError as err:
        logger.error(f"Failed to delete runs: {err}")


def _delete_results_folder(evaluator_id: str, run_id: str) -> None:
    """Delete all S3 result files for a specific run."""
    if not EVALUATIONS_BUCKET or not run_id:
        return
    prefix = f"evaluations/results/{evaluator_id}/{run_id}/"
    try:
        paginator = S3_CLIENT.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=EVALUATIONS_BUCKET, Prefix=prefix)
        to_delete = []
        for page in pages:
            for obj in page.get("Contents", []):
                to_delete.append({"Key": obj["Key"]})
        for i in range(0, len(to_delete), 1000):
            S3_CLIENT.delete_objects(
                Bucket=EVALUATIONS_BUCKET,
                Delete={"Objects": to_delete[i : i + 1000]},
            )
        if to_delete:
            logger.info(f"Deleted {len(to_delete)} result files for run {run_id}")
    except ClientError as err:
        logger.error(f"Failed to delete results for run {run_id}: {err}")


@tracer.capture_method
def _load_test_cases(s3_path: str) -> list[dict]:
    if not s3_path or not s3_path.startswith("s3://"):
        return []
    try:
        bucket, key = _parse_s3_uri(s3_path)
        response = S3_CLIENT.get_object(Bucket=bucket, Key=key)
        return json.loads(response["Body"].read().decode("utf-8"))
    except (ClientError, json.JSONDecodeError) as err:
        logger.error(f"Failed to load test cases: {err}")
        return []


# ========================= Formatters ========================= #


def _format_evaluator(item: dict, include_run_detail: bool = False) -> dict:
    """Format a DynamoDB evaluator item to the GraphQL Evaluator type."""
    evaluator_name = item.get("EvaluatorName", "")
    threshold = item.get("PassThreshold")
    result = {
        "evaluatorId": evaluator_name,
        "name": evaluator_name,
        "description": item.get("Description"),
        "evaluatorType": item.get("EvaluatorType"),
        "customRubric": item.get("CustomRubric"),
        "agentRuntimeName": item.get("AgentRuntimeName"),
        "qualifier": item.get("Qualifier"),
        "modelId": item.get("ModelId"),
        "passThreshold": float(threshold) if threshold is not None else None,
        "repeatCount": _to_int(item.get("RepeatCount")) or 1,
        "testCasesS3Path": item.get("TestCasesS3Path"),
        "testCasesCount": item.get("TestCasesCount", 0),
        "createdAt": item.get("CreatedAt"),
        "updatedAt": item.get("UpdatedAt"),
        "lastRunId": item.get("LastRunId"),
        "lastRunStatus": item.get("LastRunStatus"),
        "lastRunPassedCases": _to_int(item.get("LastRunPassedCases")),
        "lastRunFailedCases": _to_int(item.get("LastRunFailedCases")),
        "lastRunAt": item.get("LastRunAt"),
        # ---- Deprecated backwards-compat fields (mirror the last run) ----
        # Cheap fields come straight from the denormalized last-run pointer so
        # list operations stay a single scan. Heavy fields (results, full run
        # record) are only hydrated for single-evaluator fetches below.
        "status": item.get("LastRunStatus"),
        "passedCases": _to_int(item.get("LastRunPassedCases")),
        "failedCases": _to_int(item.get("LastRunFailedCases")),
        "completedAt": item.get("LastRunAt"),
        "startedAt": item.get("LastRunAt"),
        "totalTimeMs": None,
        "resultsS3Path": None,
        "results": [],
        "errorMessage": None,
    }

    # For single-evaluator fetches, hydrate the heavy deprecated fields from the
    # most recent run record so pre-split clients that read Evaluator.results
    # still get data. Skipped for list scans to avoid N extra reads.
    if include_run_detail and item.get("LastRunId"):
        last_run = _get_run_item(evaluator_name, item["LastRunId"])
        if last_run:
            run_fmt = _format_run(last_run, include_results=True)
            if run_fmt:
                result["totalTimeMs"] = run_fmt.get("totalTimeMs")
                result["resultsS3Path"] = run_fmt.get("resultsS3Path")
                result["results"] = run_fmt.get("results") or []
                result["errorMessage"] = run_fmt.get("errorMessage")
                result["startedAt"] = run_fmt.get("startedAt") or result["startedAt"]
                result["completedAt"] = (
                    run_fmt.get("completedAt") or result["completedAt"]
                )

    return result


def _format_run(item: Optional[dict], include_results: bool = False) -> Optional[dict]:
    """Format a DynamoDB run item to the GraphQL EvaluatorRun type."""
    if not item:
        return None

    results: list = []
    results_s3_path = item.get("ResultsS3Path", "")
    if include_results and results_s3_path:
        results = _load_results_from_s3(results_s3_path)

    threshold = item.get("PassThreshold")
    return {
        "runId": item.get("RunId"),
        "evaluatorId": item.get("EvaluatorId"),
        "evaluatorName": item.get("EvaluatorName"),
        "evaluatorType": item.get("EvaluatorType"),
        "customRubric": item.get("CustomRubric"),
        "agentRuntimeName": item.get("AgentRuntimeName"),
        "qualifier": item.get("Qualifier"),
        "runtimeVersion": item.get("RuntimeVersion"),
        "modelId": item.get("ModelId"),
        "passThreshold": float(threshold) if threshold is not None else None,
        "repeatCount": _to_int(item.get("RepeatCount")) or 1,
        "testCasesS3Path": item.get("TestCasesS3Path"),
        "testCasesCount": _to_int(item.get("TestCasesCount")),
        "resultsS3Path": results_s3_path,
        "status": item.get("Status"),
        "totalCases": _to_int(item.get("TotalCases")),
        "passedCases": _to_int(item.get("PassedCases")),
        "failedCases": _to_int(item.get("FailedCases")),
        "skippedCases": _to_int(item.get("SkippedCases")),
        "totalTimeMs": _to_int(item.get("TotalTimeMs")),
        "results": [_format_evaluation_result(r) for r in results] if results else [],
        "errorMessage": item.get("ErrorMessage"),
        "createdAt": item.get("CreatedAt"),
        "startedAt": item.get("StartedAt"),
        "completedAt": item.get("CompletedAt"),
    }


def _load_results_from_s3(s3_path: str) -> list[dict]:
    if not s3_path or not s3_path.startswith("s3://"):
        return []
    try:
        bucket, key = _parse_s3_uri(s3_path)
        response = S3_CLIENT.get_object(Bucket=bucket, Key=key)
        data = json.loads(response["Body"].read().decode("utf-8"))
        return data.get("results", [])
    except (ClientError, json.JSONDecodeError) as err:
        logger.error(f"Failed to load results from S3: {err}")
        return []


def _format_evaluation_result(result: dict) -> dict:
    score = result.get("score", 0)
    passed = (
        score >= 80 if isinstance(score, (int, float)) else result.get("passed", False)
    )
    repetitions = [
        {
            "repeatIndex": _to_int(rep.get("repeatIndex")) or 0,
            "actualOutput": rep.get("actualOutput") or rep.get("actual_output"),
            "score": rep.get("score", 0),
            "passed": rep.get("passed", False),
            "status": rep.get("status", "scored"),
            "reason": rep.get("reason"),
            "latencyMs": rep.get("latencyMs") or rep.get("latency_ms"),
        }
        for rep in (result.get("repetitions") or [])
    ]
    return {
        "caseName": result.get("caseName") or result.get("case_name"),
        "input": result.get("input"),
        "expectedOutput": result.get("expectedOutput") or result.get("expected_output"),
        "actualOutput": result.get("actualOutput") or result.get("actual_output"),
        "score": score,
        "passed": passed,
        "status": result.get("status", "scored"),
        "reason": result.get("reason"),
        "latencyMs": result.get("latencyMs") or result.get("latency_ms"),
        "repeatCount": _to_int(result.get("repeatCount")) or 1,
        "repetitions": repetitions,
        # Structured per-evaluator breakdown. Older runs lack this key and map
        # to [] (backwards compatible). Accept both the current "evaluatorType"
        # key and the legacy "type" key defensively.
        "evaluatorBreakdown": [
            {
                "evaluatorType": b.get("evaluatorType") or b.get("type"),
                "score": b.get("score"),
                "passed": b.get("passed"),
                "status": b.get("status"),
                "reason": b.get("reason"),
            }
            for b in (result.get("evaluatorBreakdown") or [])
        ],
    }


def _to_int(value) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return int(value)
    return value


def _parse_s3_uri(s3_uri: str) -> tuple[str, str]:
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
