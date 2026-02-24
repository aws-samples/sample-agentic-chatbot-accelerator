# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Evaluation Executor Lambda
Processes individual test cases from SQS queue
"""
from __future__ import annotations

import codecs
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional, Tuple

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import SQSEvent, event_source
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.parser import BaseModel, parse
from botocore.exceptions import ClientError

# Import evaluator classes
from evaluator import EvaluationRunner

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext


# ===================== Models ==================== #
class TestCase(BaseModel):
    """Test case data model."""

    name: str
    input: str
    expectedOutput: Optional[str] = None
    metadata: Optional[dict] = None


class EvaluatorConfig(BaseModel):
    """Evaluator configuration model."""

    evaluatorType: str
    agentRuntimeName: str
    qualifier: str = "DEFAULT"
    customRubric: Optional[str] = None
    modelId: str
    passThreshold: float


class SQSMessagePayload(BaseModel):
    """SQS message payload model for test case execution."""

    evaluatorId: str
    testCaseIndex: int
    testCase: TestCase
    evaluatorConfig: EvaluatorConfig


# ---------------------------------------------------------- #

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="evaluation-executor")
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
EVALUATIONS_TABLE_NAME = os.environ.get("EVALUATIONS_TABLE", "")
EVALUATIONS_BUCKET = os.environ.get("EVALUATIONS_BUCKET", "")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
DYNAMODB = boto3.resource("dynamodb")
EVALUATIONS_TABLE = DYNAMODB.Table(EVALUATIONS_TABLE_NAME) if EVALUATIONS_TABLE_NAME else None  # type: ignore
S3_CLIENT = boto3.client("s3")
AC_CLIENT = boto3.client("bedrock-agentcore")
ACC_CLIENT = boto3.client("bedrock-agentcore-control")
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


@tracer.capture_method
def process_record(record: SQSRecord):
    """Process a single test case from SQS.

    Uses Pydantic models for type-safe message parsing and validation.
    Missing or invalid fields will raise ValidationError.
    """
    # Parse and validate SQS message payload using Pydantic
    payload: SQSMessagePayload = parse(event=record.body, model=SQSMessagePayload)

    evaluator_id = payload.evaluatorId
    test_case_index = payload.testCaseIndex
    test_case = payload.testCase
    evaluator_config = payload.evaluatorConfig

    logger.info(
        f"Processing test case {test_case_index} for evaluator {evaluator_id}",
        extra={
            "evaluatorId": evaluator_id,
            "testCaseIndex": test_case_index,
            "testCaseName": test_case.name,
        },
    )

    session_id = None
    agent_runtime_arn = None
    qualifier = None

    try:
        start_time = time.time()
        qualifier = evaluator_config.qualifier

        # Step 1: Invoke AgentCore runtime
        result = _invoke_agent_runtime(
            test_case=test_case.model_dump(),
            agent_runtime_name=evaluator_config.agentRuntimeName,
            qualifier=qualifier,
        )

        session_id = result.get("sessionId")
        agent_runtime_arn = result.get("agentRuntimeArn")

        # Step 2: Evaluate the result
        evaluation = _evaluate_result(
            test_case=test_case,
            actual_output=result.get("output", ""),
            evaluator_config=evaluator_config,
            trajectory=result.get("trajectory"),
        )

        # Add latency
        evaluation["latencyMs"] = int((time.time() - start_time) * 1000)

        # Step 3: Save individual test case result to S3
        _save_test_case_result(
            evaluator_id=evaluator_id,
            test_case_index=test_case_index,
            evaluation=evaluation,
        )

        # Step 4: Update progress counters atomically
        _update_progress(
            evaluator_id=evaluator_id,
            passed=evaluation.get("passed", False),
        )

        logger.info(
            f"Completed test case {test_case_index}",
            extra={
                "evaluatorId": evaluator_id,
                "passed": evaluation.get("passed"),
                "score": evaluation.get("score"),
            },
        )

    except Exception as e:
        logger.exception(f"Failed to process test case {test_case_index}: {e}")

        # Update progress with failure
        _update_progress(
            evaluator_id=evaluator_id,
            passed=False,
        )

        # Re-raise to trigger SQS retry
        raise

    finally:
        # Step 5: Always destroy runtime session if created
        if session_id and agent_runtime_arn:
            try:
                _stop_runtime_session(
                    session_id=session_id,
                    agent_runtime_arn=agent_runtime_arn,
                    qualifier=qualifier or "DEFAULT",
                )
            except Exception as e:
                logger.warning(f"Failed to stop runtime session {session_id}: {e}")


@tracer.capture_method
def _parse_sse_events(stream: str) -> Tuple[list[dict], str]:
    """Parse SSE events from stream and extract JSON events.

    Args:
        stream: Raw stream data containing SSE events

    Returns:
        Tuple[list[dict], str]: Parsed events and remaining unparsed data
    """
    parsed_events = []
    unparsed_data = stream

    while True:
        event_match = re.search(r"data: ({.*?})\n", unparsed_data)
        if not event_match:
            break
        try:
            parsed_events.append(json.loads(event_match.group(1)))
            unparsed_data = (
                unparsed_data[: event_match.start()]
                + unparsed_data[event_match.end() :]
            )
        except json.JSONDecodeError:
            break

    return parsed_events, unparsed_data


@tracer.capture_method
def _invoke_agent_runtime(
    test_case: dict,
    agent_runtime_name: str,
    qualifier: str,
) -> dict:
    """Invoke AgentCore runtime with test case input.

    Args:
        test_case: Test case with input
        agent_runtime_name: Name of the agent runtime
        qualifier: Runtime qualifier (LATEST, PROD, etc.)

    Returns:
        dict: Response with output and sessionId

    Raises:
        RuntimeError: If agent runtime not found or invocation fails
    """
    input_text = test_case.get("input", "")

    logger.info(
        f"Invoking agent runtime {agent_runtime_name}:{qualifier}",
        extra={
            "agentRuntimeName": agent_runtime_name,
            "qualifier": qualifier,
            "inputLength": len(input_text),
        },
    )

    # Step 1: Fetch agent runtime ARN from agent name
    agent_runtime_arn = _fetch_agent_runtime_arn(agent_runtime_name)
    if not agent_runtime_arn:
        raise RuntimeError(
            f"Agent runtime not found for agent name: {agent_runtime_name}"
        )

    # Step 2: Generate session ID for this test case
    # Use UUID to ensure unique and valid length
    session_id = f"eval-{uuid.uuid4()}"

    # Step 3: Prepare payload
    # Include trajectory flag to capture agent reasoning traces for evaluation
    # Trajectory data is required by evaluators like HelpfulnessEvaluator,
    # FaithfulnessEvaluator, and other trajectory-based evaluators
    payload = json.dumps(
        {
            "prompt": input_text,
            "userId": "evaluation-executor",
            "includeTrajectory": True,  # Capture agent trajectory for evaluation
        }
    ).encode()

    # Step 4: Invoke agent runtime
    try:
        response = AC_CLIENT.invoke_agent_runtime(
            agentRuntimeArn=agent_runtime_arn,
            runtimeSessionId=session_id,
            runtimeUserId="evaluation-executor",
            payload=payload,
            qualifier=qualifier,
        )

        # Step 5: Parse streaming response using incremental UTF-8 decoder
        # This handles UTF-8 characters that may be split across chunk boundaries
        utf8_decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        buffer = ""
        response_data = {}

        for chunk in response.get("response", []):
            # final=False allows incomplete UTF-8 sequences at end of chunk
            decoded_text = utf8_decoder.decode(chunk, final=False)
            events, buffer = _parse_sse_events(buffer + decoded_text)

            for event in events:
                if event.get("action") == "final_response":
                    response_data = event.get("data", {})
                    logger.info(
                        "The agent returned a final response", extra={"event": event}
                    )
                elif event.get("error"):
                    logger.error(f"Agent runtime error: {event['error']}")
                    raise RuntimeError(event["error"])
                else:
                    logger.debug("Parsed event", extra={"event": event})

        # Flush any remaining bytes from the decoder
        final_text = utf8_decoder.decode(b"", final=True)
        if final_text:
            events, buffer = _parse_sse_events(buffer + final_text)
            for event in events:
                if event.get("action") == "final_response":
                    response_data = event.get("data", {})
                    logger.info(
                        "The agent returned a final response", extra={"event": event}
                    )
                elif event.get("error"):
                    logger.error(f"Agent runtime error: {event['error']}")
                    raise RuntimeError(event["error"])
                else:
                    logger.debug("Parsed event", extra={"event": event})

        output = response_data.get("content", "")
        trajectory = response_data.get("trajectory")

        logger.info(
            "Agent runtime invocation successful",
            extra={
                "sessionId": session_id,
                "outputLength": len(str(output)),
                "hasTrajectory": trajectory is not None,
            },
        )

        return {
            "output": output,
            "sessionId": session_id,
            "agentRuntimeArn": agent_runtime_arn,
            "trajectory": trajectory,  # Include trajectory for evaluators
        }

    except ClientError as e:
        error_msg = f"AgentCore runtime invocation failed: {str(e)}"
        logger.error(error_msg, extra={"error": str(e)})
        raise RuntimeError(error_msg) from e


@tracer.capture_method
def _fetch_agent_runtime_arn(agent_runtime_name: str) -> Optional[str]:
    """Fetch agent runtime ARN from agent runtime name.

    Uses bedrock-agentcore-control API to list agent runtimes and find
    the one matching the given name.

    Args:
        agent_runtime_name: Name of the agent runtime

    Returns:
        Agent runtime ARN if found, None otherwise
    """
    try:
        next_token = None

        while True:
            api_arguments = {"maxResults": 10}
            if next_token:
                api_arguments["nextToken"] = next_token

            response = ACC_CLIENT.list_agent_runtimes(**api_arguments)
            next_token = response.get("nextToken")

            # Search for matching agent runtime
            for elem in response.get("agentRuntimes", []):
                logger.debug(
                    f"Checking runtime: {elem.get('agentRuntimeName')} == {agent_runtime_name}"
                )
                if elem.get("agentRuntimeName") == agent_runtime_name:
                    agent_runtime_arn = elem.get("agentRuntimeArn")
                    logger.info(
                        f"Found agent runtime: {agent_runtime_name} -> {agent_runtime_arn}"
                    )
                    return agent_runtime_arn

            # Break if no more pages
            if not next_token:
                break

        logger.warning(
            f"Agent runtime not found: {agent_runtime_name}",
            extra={"agentRuntimeName": agent_runtime_name},
        )
        return None

    except ClientError as e:
        logger.error(
            f"Failed to fetch agent runtime: {e}",
            extra={"agentRuntimeName": agent_runtime_name, "error": str(e)},
        )
        return None


@tracer.capture_method
def _evaluate_result(
    test_case: TestCase,
    actual_output: str,
    evaluator_config: EvaluatorConfig,
    trajectory: Optional[dict] = None,
) -> dict:
    """Evaluate the agent's output using Strands Evals SDK.

    Supports multiple comma-separated evaluator types (e.g., "OutputEvaluator, HelpfulnessEvaluator").
    When multiple types are provided, runs each evaluator separately and aggregates results.

    Uses the evaluator module which supports 5 built-in evaluators:
    - OutputEvaluator: Compares actual vs expected output (works without trajectory)
    - HelpfulnessEvaluator: Evaluates response helpfulness (requires trajectory)
    - FaithfulnessEvaluator: Checks factual accuracy (requires trajectory)
    - ToolSelectionAccuracyEvaluator: Validates tool selection (requires trajectory)
    - ToolParameterAccuracyEvaluator: Validates tool parameters (requires trajectory)

    Args:
        test_case: TestCase model with input, expected output, and metadata
        actual_output: Actual output from agent
        evaluator_config: Configuration with evaluator types, rubrics, and thresholds
        trajectory: Optional trajectory data from agent for advanced evaluators

    Returns:
        dict: Evaluation result with score, passed, reason
    """
    expected_output = test_case.expectedOutput or ""
    case_name = test_case.name
    input_text = test_case.input

    # Parse multiple evaluator types (comma-separated)
    evaluator_types = [
        t.strip() for t in evaluator_config.evaluatorType.split(",") if t.strip()
    ]

    # Get rubric from payload
    rubric = evaluator_config.customRubric or ""

    # Get model ID and pass threshold from payload
    model_id = evaluator_config.modelId
    pass_threshold = evaluator_config.passThreshold

    logger.info(
        f"Evaluating with {len(evaluator_types)} evaluator(s): {evaluator_types}",
        extra={
            "evaluatorTypes": evaluator_types,
            "hasCustomRubric": bool(rubric),
            "modelId": model_id,
            "passThreshold": pass_threshold,
        },
    )

    # Run each evaluator and collect results
    all_results = []
    all_reasons = []

    # Create evaluation runner
    runner = EvaluationRunner(
        pass_threshold=pass_threshold,
        model_id=model_id,
    )

    for eval_type in evaluator_types:
        try:
            result = runner.evaluate(
                evaluator_type=eval_type,
                rubric=rubric,
                input_text=input_text,
                expected_output=expected_output,
                actual_output=actual_output,
                trajectory=trajectory,
            )

            score = result.score
            passed = result.passed
            reason = result.reason

            all_results.append(
                {
                    "type": eval_type,
                    "score": score,
                    "passed": passed,
                    "reason": str(reason),
                }
            )

            # Format: [EvaluatorName - Score%] reason
            # Remove "Evaluator" suffix for cleaner display
            display_name = eval_type.replace("Evaluator", "")
            score_pct = int(score * 100)
            all_reasons.append(f"[{display_name} - {score_pct}%]\n{reason}")

            logger.info(
                f"Evaluator {eval_type}: score={score:.2f}, passed={passed}",
                extra={"evaluatorType": eval_type, "score": score, "passed": passed},
            )

        except Exception as e:
            logger.exception(f"Evaluator {eval_type} failed: {e}")
            all_results.append(
                {
                    "type": eval_type,
                    "score": 0.0,
                    "passed": False,
                    "reason": f"Error: {str(e)}",
                }
            )
            display_name = eval_type.replace("Evaluator", "")
            all_reasons.append(f"[{display_name} - 0%]\n{str(e)}")

    # Calculate aggregated score (average of all evaluators)
    if all_results:
        avg_score = sum(r["score"] for r in all_results) / len(all_results)
        final_score = int(avg_score * 100)  # Convert to percentage
    else:
        final_score = 0
        avg_score = 0.0

    # Determine passed based on average score using threshold from payload
    final_passed = avg_score >= pass_threshold

    # Combine reasons
    combined_reason = "\n".join(all_reasons)

    logger.info(
        f"Evaluation complete: score={final_score}, passed={final_passed}",
        extra={
            "evaluatorTypes": evaluator_types,
            "score": final_score,
            "passed": final_passed,
            "individualResults": all_results,
        },
    )

    return {
        "caseName": case_name,
        "input": input_text,
        "expectedOutput": expected_output,
        "actualOutput": actual_output,
        "score": final_score,
        "passed": final_passed,
        "reason": combined_reason,
        "evaluatorResults": all_results,  # Include individual results for detailed view
    }


@tracer.capture_method
def _stop_runtime_session(
    session_id: str,
    agent_runtime_arn: str,
    qualifier: str = "DEFAULT",
) -> None:
    """Destroy AgentCore runtime session to free up resources.

    Args:
        session_id: Session ID to stop
        agent_runtime_arn: ARN of the agent runtime
        qualifier: Runtime qualifier (endpoint name)
    """
    try:
        logger.info(
            f"Stopping runtime session {session_id}",
            extra={
                "sessionId": session_id,
                "agentRuntimeArn": agent_runtime_arn,
                "qualifier": qualifier,
            },
        )

        # Stop the runtime session to free up resources
        AC_CLIENT.stop_runtime_session(
            agentRuntimeArn=agent_runtime_arn,
            runtimeSessionId=session_id,
            qualifier=qualifier,
        )

        logger.info(f"Successfully stopped runtime session {session_id}")
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        if error_code == "ResourceNotFoundException":
            logger.warning(f"Session {session_id} not found (may have already expired)")
        elif error_code == "AccessDeniedException":
            logger.warning(
                f"No permission to stop session {session_id} (will auto-expire) : {e}"
            )
        else:
            logger.warning(f"Failed to stop runtime session {session_id}: {e}")


@tracer.capture_method
def _save_test_case_result(
    evaluator_id: str,
    test_case_index: int,
    evaluation: dict,
) -> None:
    """Save individual test case result to S3.

    Results are saved incrementally as they complete, allowing users to see
    partial results before the entire evaluation finishes.

    Args:
        evaluator_id: Evaluator ID
        test_case_index: Index of the test case
        evaluation: Evaluation result
    """
    if not EVALUATIONS_BUCKET:
        logger.warning("EVALUATIONS_BUCKET not configured, skipping S3 save")
        return

    s3_key = f"evaluations/results/{evaluator_id}/test_case_{test_case_index:04d}.json"

    result_data = {
        "evaluatorId": evaluator_id,
        "testCaseIndex": test_case_index,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "evaluation": evaluation,
    }

    try:
        S3_CLIENT.put_object(
            Bucket=EVALUATIONS_BUCKET,
            Key=s3_key,
            Body=json.dumps(result_data, indent=2, cls=DecimalEncoder),
            ContentType="application/json",
        )
        logger.info(f"Saved test case result to s3://{EVALUATIONS_BUCKET}/{s3_key}")
    except ClientError as e:
        logger.error(f"Failed to save test case result to S3: {e}")


@tracer.capture_method
def _update_progress(
    evaluator_id: str,
    passed: bool,
) -> None:
    """Atomically update evaluation progress counters and check for completion.

    Args:
        evaluator_id: Evaluator ID
        passed: Whether the test case passed
    """
    if not EVALUATIONS_TABLE:
        logger.error("EVALUATIONS_TABLE not configured")
        return

    try:
        response = EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluator_id},
            UpdateExpression="""
                SET CompletedCases = if_not_exists(CompletedCases, :zero) + :inc,
                    PassedCases = if_not_exists(PassedCases, :zero) + :passed,
                    FailedCases = if_not_exists(FailedCases, :zero) + :failed
            """,
            ExpressionAttributeValues={
                ":zero": 0,
                ":inc": 1,
                ":passed": 1 if passed else 0,
                ":failed": 0 if passed else 1,
            },
            ReturnValues="ALL_NEW",
        )

        item = response.get("Attributes", {})
        completed = item.get("CompletedCases", 0)
        total = item.get("TotalCases", 0)
        passed_count = item.get("PassedCases", 0)
        failed_count = item.get("FailedCases", 0)

        logger.info(
            f"Progress update: {completed}/{total} completed",
            extra={
                "evaluatorId": evaluator_id,
                "completed": completed,
                "total": total,
                "passed": passed_count,
                "failed": failed_count,
            },
        )

        # Check if evaluation is complete
        if completed >= total > 0:
            logger.info(f"Evaluation {evaluator_id} completed: {completed}/{total}")
            _finalize_evaluation(evaluator_id, item)

    except ClientError as e:
        logger.error(f"Failed to update progress: {e}")
        raise


@tracer.capture_method
def _finalize_evaluation(evaluator_id: str, item: dict) -> None:
    """Finalize evaluation by aggregating results and updating status.

    Args:
        evaluator_id: Evaluator ID
        item: Current evaluator item from DynamoDB
    """
    logger.info(f"Finalizing evaluation {evaluator_id}")

    try:
        # Aggregate all test case results from S3
        results = _load_all_test_case_results(evaluator_id)

        # Calculate final metrics
        total_time_ms = sum(r.get("latencyMs", 0) for r in results)

        # Save aggregated results to S3
        results_s3_path = _save_aggregated_results(
            evaluator_id=evaluator_id,
            results=results,
            metrics={
                "passedCases": item.get("PassedCases", 0),
                "failedCases": item.get("FailedCases", 0),
                "totalTimeMs": total_time_ms,
                "completedAt": datetime.now(timezone.utc).isoformat(),
            },
        )

        # Update status to Completed
        timestamp = datetime.now(timezone.utc).isoformat()

        EVALUATIONS_TABLE.update_item(
            Key={"EvaluatorName": evaluator_id},
            UpdateExpression="""
                SET #s = :status,
                    TotalTimeMs = :time,
                    CompletedAt = :completed,
                    ResultsS3Path = :resultsPath
            """,
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Completed",
                ":time": total_time_ms,
                ":completed": timestamp,
                ":resultsPath": results_s3_path,
            },
        )

        logger.info(f"Evaluation {evaluator_id} finalized successfully")

    except Exception as e:
        logger.exception(f"Failed to finalize evaluation: {e}")
        _update_evaluator_failed(evaluator_id, str(e))


@tracer.capture_method
def _load_all_test_case_results(evaluator_id: str) -> list[dict]:
    """Load all test case results from S3 for final aggregation.

    Args:
        evaluator_id: Evaluator ID

    Returns:
        list: All test case evaluation results
    """
    if not EVALUATIONS_BUCKET:
        return []

    results = []
    prefix = f"evaluations/results/{evaluator_id}/"

    try:
        paginator = S3_CLIENT.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=EVALUATIONS_BUCKET, Prefix=prefix)

        for page in pages:
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith(".json"):
                    continue

                response = S3_CLIENT.get_object(Bucket=EVALUATIONS_BUCKET, Key=key)
                content = response["Body"].read().decode("utf-8")
                data = json.loads(content)

                evaluation = data.get("evaluation", {})
                if evaluation:
                    results.append(evaluation)

        logger.info(f"Loaded {len(results)} test case results from S3")
        return results

    except ClientError as e:
        logger.error(f"Failed to load test case results: {e}")
        return []


@tracer.capture_method
def _save_aggregated_results(
    evaluator_id: str,
    results: list[dict],
    metrics: dict,
) -> str:
    """Save aggregated evaluation results to S3.

    Args:
        evaluator_id: Evaluator ID
        results: All test case results
        metrics: Summary metrics

    Returns:
        str: S3 path where results were saved
    """
    if not EVALUATIONS_BUCKET:
        logger.warning("EVALUATIONS_BUCKET not configured, skipping S3 save")
        return ""

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    s3_key = f"evaluations/results/{evaluator_id}/{timestamp}_aggregated_results.json"

    results_data = {
        "evaluatorId": evaluator_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metrics": metrics,
        "results": results,
    }

    try:
        S3_CLIENT.put_object(
            Bucket=EVALUATIONS_BUCKET,
            Key=s3_key,
            Body=json.dumps(results_data, indent=2, cls=DecimalEncoder),
            ContentType="application/json",
        )
        s3_path = f"s3://{EVALUATIONS_BUCKET}/{s3_key}"
        logger.info(f"Saved aggregated results to {s3_path}")
        return s3_path
    except ClientError as e:
        logger.error(f"Failed to save aggregated results: {e}")
        return ""


def _update_evaluator_failed(evaluator_id: str, error_message: str) -> None:
    """Update evaluator status to Failed."""
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
    except ClientError as e:
        logger.error(f"Failed to update evaluator status: {e}")


# ========================= Handler ========================= #


@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
@event_source(data_class=SQSEvent)
def handler(event: SQSEvent, context: LambdaContext):
    """Lambda handler for processing SQS messages.

    Processes each test case message from the SQS queue.
    Each message represents a single test case to evaluate.
    """
    messages = event.raw_event["Records"]
    logger.info(f"Processing {len(messages)} test case(s)")

    # Process each test case
    for record in messages:
        try:
            process_record(record=SQSRecord(record))
        except Exception as e:
            logger.exception(f"Failed to process record: {e}")
            # SQS will retry the message based on queue configuration
            raise

    return {
        "statusCode": 200,
        "body": f"Processed {len(messages)} test case(s)",
    }
