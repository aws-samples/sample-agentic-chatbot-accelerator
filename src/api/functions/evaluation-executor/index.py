# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""
Evaluation Executor Lambda.

Processes individual test cases from SQS queue.
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
from typing import TYPE_CHECKING, Optional, Tuple, Union

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import SQSEvent, event_source
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.parser import BaseModel, parse
from botocore.config import Config
from botocore.exceptions import ClientError

# Import evaluator classes
from evaluator import EvaluationRunner
from pydantic import ConfigDict, Field

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext


# ===================== Models ==================== #
class TestCase(BaseModel):
    """Test case data model.

    Accepts both snake_case (from test case JSON files) and camelCase field names.
    E.g. both "expected_output" and "expectedOutput" map to the same field.
    """

    model_config = ConfigDict(populate_by_name=True)

    name: str
    input: str
    expectedOutput: Optional[Union[str, dict]] = Field(
        default=None, alias="expected_output"
    )
    expected_trajectory: Optional[list] = None
    expected_interactions: Optional[list] = None
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
    runId: str
    testCaseIndex: int
    repeatIndex: int = 0
    testCase: TestCase
    evaluatorConfig: EvaluatorConfig


# ---------------------------------------------------------- #

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer()
logger = Logger(service="evaluation-executor")
# ---------------------------------------------------------- #

# -------------------- Env Variables ----------------------- #
EVALUATIONS_TABLE_NAME = os.environ.get("EVALUATIONS_TABLE", "")
EVALUATOR_RUNS_TABLE_NAME = os.environ.get("EVALUATOR_RUNS_TABLE", "")
EVALUATIONS_BUCKET = os.environ.get("EVALUATIONS_BUCKET", "")
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

# Configure extended timeout for agent runtime invocations
# Agent invocations can take a long time for complex tasks
# Default boto3 timeout is 60 seconds, which is insufficient
AGENT_RUNTIME_CONFIG = Config(
    read_timeout=300,  # 5 minutes for reading response
    connect_timeout=30,  # 30 seconds for initial connection
    retries={"max_attempts": 2},
)
AC_CLIENT = boto3.client("bedrock-agentcore", config=AGENT_RUNTIME_CONFIG)
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


# Must match the DLQ maxReceiveCount on the SQS event source (evaluation-api.ts).
# On the final allowed receive we record the unit as failed and advance progress
# instead of re-raising, so a permanently-failing unit cannot wedge the run in
# "Running" forever (finalize triggers only when CompletedUnits == TotalUnits).
_MAX_RECEIVE_COUNT = 3


@tracer.capture_method
def process_record(record: SQSRecord):
    """Process a single test case from SQS.

    Uses Pydantic models for type-safe message parsing and validation.
    Missing or invalid fields will raise ValidationError.
    """
    # Parse and validate SQS message payload using Pydantic
    payload: SQSMessagePayload = parse(event=record.body, model=SQSMessagePayload)  # type: ignore

    evaluator_id = payload.evaluatorId
    run_id = payload.runId
    test_case_index = payload.testCaseIndex
    repeat_index = payload.repeatIndex
    test_case = payload.testCase
    evaluator_config = payload.evaluatorConfig

    logger.info(
        f"Processing test case {test_case_index} rep {repeat_index} for run {run_id}",
        extra={
            "evaluatorId": evaluator_id,
            "runId": run_id,
            "testCaseIndex": test_case_index,
            "repeatIndex": repeat_index,
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
            actual_structured_output=result.get("structuredOutput"),
        )

        # Add latency
        evaluation["latencyMs"] = int((time.time() - start_time) * 1000)

        # Step 3: Save individual test case repetition result to S3
        _save_test_case_result(
            evaluator_id=evaluator_id,
            run_id=run_id,
            test_case_index=test_case_index,
            repeat_index=repeat_index,
            evaluation=evaluation,
        )

        # Step 4: Update unit progress counter; finalize on the last unit
        _update_progress(
            evaluator_id=evaluator_id,
            run_id=run_id,
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

        # How many times has SQS delivered this message? On earlier attempts we
        # re-raise to let SQS retry (transient AgentCore hangs often succeed on
        # retry). On the FINAL allowed attempt, record the unit as a failed
        # result and advance the counter so the run can still finalize instead
        # of getting stuck below TotalUnits when the message would otherwise be
        # silently dropped to the DLQ.
        receive_count = int(record.attributes.approximate_receive_count or "1")
        if receive_count < _MAX_RECEIVE_COUNT:
            raise  # let SQS retry

        logger.warning(
            f"Unit case={test_case_index} rep={repeat_index} failed on final "
            f"attempt ({receive_count}/{_MAX_RECEIVE_COUNT}); recording as error "
            f"so the run can finalize",
            extra={"evaluatorId": evaluator_id, "runId": run_id},
        )
        try:
            _save_test_case_result(
                evaluator_id=evaluator_id,
                run_id=run_id,
                test_case_index=test_case_index,
                repeat_index=repeat_index,
                evaluation={
                    "caseName": test_case.name,
                    "input": test_case.input,
                    "expectedOutput": test_case.expectedOutput or "",
                    "actualOutput": "",
                    "score": 0,
                    "passed": False,
                    "status": "error",
                    "reason": f"Execution failed after {receive_count} attempts: {e}",
                    "latencyMs": 0,
                },
            )
            _update_progress(evaluator_id=evaluator_id, run_id=run_id)
        except Exception as inner:
            # If we can't even record the failure, fall back to re-raising so
            # the message isn't lost without a trace.
            logger.exception(f"Failed to record terminal unit failure: {inner}")
            raise
        # Swallowed: the unit is accounted for, so do not re-raise.

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
    payload_dict = {
        "prompt": input_text,
        "userId": "evaluation-executor",
        "includeTrajectory": True,  # Capture agent trajectory for evaluation
    }

    # Include state if provided in the test case (stringified JSON).
    # This allows evaluation of agents whose tools rely on agent state
    # (e.g. S3 URI references for document processing).
    state = test_case.get("state")
    if state:
        payload_dict["state"] = state

    payload = json.dumps(payload_dict).encode()

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
        structured_output = response_data.get("structuredOutput")
        trajectory = response_data.get("trajectory")

        logger.info(
            "Agent runtime invocation successful",
            extra={
                "sessionId": session_id,
                "outputLength": len(str(output)),
                "hasStructuredOutput": structured_output is not None,
                "hasTrajectory": trajectory is not None,
            },
        )

        return {
            "output": output,  # Canonical text output for most evaluators
            "structuredOutput": structured_output,  # Dict for StructuredOutputEvaluator
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
    actual_structured_output: Optional[dict] = None,
) -> dict:
    """Evaluate the agent's output using Strands Evals SDK.

    Supports multiple comma-separated evaluator types (e.g., "OutputEvaluator, HelpfulnessEvaluator").
    When multiple types are provided, runs each evaluator separately and aggregates results.

    Uses the evaluator module which supports built-in and custom evaluators:
    - OutputEvaluator: Compares actual vs expected output (works without trajectory)
    - HelpfulnessEvaluator: Evaluates response helpfulness (requires trajectory)
    - FaithfulnessEvaluator: Checks factual accuracy (requires trajectory)
    - ToolSelectionAccuracyEvaluator: Validates tool selection (requires trajectory)
    - ToolParameterAccuracyEvaluator: Validates tool parameters (requires trajectory)
    - StructuredOutputEvaluator: Deterministic JSON field comparison (no LLM needed)

    Args:
        test_case: TestCase model with input, expected output, and metadata
        actual_output: Actual canonical text output from agent
        evaluator_config: Configuration with evaluator types, rubrics, and thresholds
        trajectory: Optional trajectory data from agent for advanced evaluators
        actual_structured_output: Optional structured output dict from the agent.
            Passed to StructuredOutputEvaluator for field-level comparison.

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
        display_name = eval_type.replace("Evaluator", "")
        try:
            result = runner.evaluate(
                evaluator_type=eval_type,
                rubric=rubric,
                input_text=input_text,
                expected_output=expected_output,
                actual_output=actual_output,
                trajectory=trajectory,
                actual_structured_output=actual_structured_output,
            )

            score = result.score
            passed = result.passed
            reason = str(result.reason)
            # The runner sets status explicitly ("scored" | "skipped" | "error").
            # No inference from message text required.
            status = result.status

            all_results.append(
                {
                    "type": eval_type,
                    "score": score,
                    "passed": passed,
                    "status": status,
                    "reason": reason,
                }
            )

            score_pct = int(score * 100)
            if status == "skipped":
                all_reasons.append(f"[{display_name} - SKIPPED]\n{reason}")
            elif status == "error":
                all_reasons.append(f"[{display_name} - ERROR]\n{reason}")
            else:
                all_reasons.append(f"[{display_name} - {score_pct}%]\n{reason}")

            logger.info(
                f"Evaluator {eval_type}: score={score:.2f}, passed={passed}, status={status}",
                extra={"evaluatorType": eval_type, "score": score, "status": status},
            )

        except Exception as e:
            # Defensive: the runner catches its own errors, but if one escapes
            # treat it as a genuine error (not a skip).
            logger.exception(f"Evaluator {eval_type} failed: {e}")
            all_results.append(
                {
                    "type": eval_type,
                    "score": 0.0,
                    "passed": False,
                    "status": "error",
                    "reason": f"Error: {str(e)}",
                }
            )
            all_reasons.append(f"[{display_name} - ERROR]\n{str(e)}")

    # Only evaluators that actually produced a score count toward the result.
    # Skipped (inapplicable) evaluators are excluded so they don't drag the
    # average down — e.g. one OutputEvaluator at 100% should score 100%, not
    # 11% just because eight trajectory/tool evaluators couldn't run.
    scored_results = [r for r in all_results if r["status"] == "scored"]
    skipped_count = sum(1 for r in all_results if r["status"] == "skipped")
    error_count = sum(1 for r in all_results if r["status"] == "error")

    if scored_results:
        avg_score = sum(r["score"] for r in scored_results) / len(scored_results)
        final_score = int(avg_score * 100)
        final_passed = avg_score >= pass_threshold
        case_status = "scored"
    elif skipped_count and not error_count:
        # Every evaluator was inapplicable to this agent. The case did not
        # really fail — it could not be scored. Flag it distinctly so the UI
        # can explain it rather than showing a misleading 0%.
        avg_score = 0.0
        final_score = 0
        final_passed = False
        case_status = "skipped"
    else:
        avg_score = 0.0
        final_score = 0
        final_passed = False
        case_status = "error"

    combined_reason = "\n".join(all_reasons)

    logger.info(
        f"Evaluation complete: score={final_score}, passed={final_passed}, "
        f"status={case_status} (scored={len(scored_results)}, "
        f"skipped={skipped_count}, error={error_count})",
        extra={
            "evaluatorTypes": evaluator_types,
            "score": final_score,
            "passed": final_passed,
            "caseStatus": case_status,
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
        "status": case_status,  # "scored" | "skipped" | "error"
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
    run_id: str,
    test_case_index: int,
    repeat_index: int,
    evaluation: dict,
) -> None:
    """Save an individual (case, repetition) unit result to S3.

    Each repetition is stored separately so finalize can aggregate them into a
    per-case mean. Saved incrementally as units complete.
    """
    if not EVALUATIONS_BUCKET:
        logger.warning("EVALUATIONS_BUCKET not configured, skipping S3 save")
        return

    s3_key = (
        f"evaluations/results/{evaluator_id}/{run_id}/"
        f"case_{test_case_index:04d}_rep_{repeat_index:04d}.json"
    )

    result_data = {
        "evaluatorId": evaluator_id,
        "runId": run_id,
        "testCaseIndex": test_case_index,
        "repeatIndex": repeat_index,
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
        logger.info(f"Saved unit result to s3://{EVALUATIONS_BUCKET}/{s3_key}")
    except ClientError as e:
        logger.error(f"Failed to save unit result to S3: {e}")


@tracer.capture_method
def _update_progress(
    evaluator_id: str,
    run_id: str,
) -> None:
    """Atomically advance the completed-unit counter; finalize on the last unit.

    Per-case pass/fail/skip counts are computed at finalize time (after all
    repetitions of every case are in), so here we only track raw unit progress.
    """
    if not EVALUATOR_RUNS_TABLE:
        logger.error("EVALUATOR_RUNS_TABLE not configured")
        return

    try:
        response = EVALUATOR_RUNS_TABLE.update_item(
            Key={"EvaluatorId": evaluator_id, "RunId": run_id},
            UpdateExpression=(
                "SET CompletedUnits = if_not_exists(CompletedUnits, :zero) + :inc"
            ),
            ExpressionAttributeValues={":zero": 0, ":inc": 1},
            ReturnValues="ALL_NEW",
        )

        item = response.get("Attributes", {})
        completed = int(item.get("CompletedUnits", 0))
        total = int(item.get("TotalUnits", 0))

        logger.info(
            f"Unit progress: {completed}/{total}",
            extra={"evaluatorId": evaluator_id, "runId": run_id},
        )

        if completed >= total > 0:
            logger.info(f"Run {run_id} all units complete: {completed}/{total}")
            _finalize_run(evaluator_id, run_id, item)

    except ClientError as e:
        logger.error(f"Failed to update progress: {e}")
        raise


@tracer.capture_method
def _finalize_run(evaluator_id: str, run_id: str, item: dict) -> None:
    """Finalize a run: aggregate repetitions per case, then update status."""
    logger.info(f"Finalizing run {run_id}")

    try:
        units_by_case = _load_all_unit_results(evaluator_id, run_id)

        # Use the run's configured pass threshold (0.0-1.0) for case-level
        # pass/fail, falling back to 0.8 if absent.
        raw_threshold = item.get("PassThreshold")
        pass_threshold = float(raw_threshold) if raw_threshold is not None else 0.8

        results = []
        passed_count = 0
        failed_count = 0
        skipped_count = 0
        total_time_ms = 0

        for _, units in sorted(units_by_case.items()):
            case_result = _aggregate_case(units, pass_threshold=pass_threshold)
            results.append(case_result)
            total_time_ms += case_result.get("latencyMs", 0)

            if case_result["status"] == "skipped":
                skipped_count += 1
            elif case_result["passed"]:
                passed_count += 1
            else:
                failed_count += 1

        results_s3_path = _save_aggregated_results(
            evaluator_id=evaluator_id,
            run_id=run_id,
            results=results,
            metrics={
                "passedCases": passed_count,
                "failedCases": failed_count,
                "skippedCases": skipped_count,
                "totalTimeMs": total_time_ms,
                "completedAt": datetime.now(timezone.utc).isoformat(),
            },
        )

        timestamp = datetime.now(timezone.utc).isoformat()

        EVALUATOR_RUNS_TABLE.update_item(  # type: ignore
            Key={"EvaluatorId": evaluator_id, "RunId": run_id},
            UpdateExpression="""
                SET #s = :status,
                    TotalTimeMs = :time,
                    CompletedAt = :completed,
                    PassedCases = :passed,
                    FailedCases = :failed,
                    SkippedCases = :skipped,
                    ResultsS3Path = :resultsPath
            """,
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Completed",
                ":time": total_time_ms,
                ":completed": timestamp,
                ":passed": passed_count,
                ":failed": failed_count,
                ":skipped": skipped_count,
                ":resultsPath": results_s3_path,
            },
        )

        _update_last_run_pointer(
            evaluator_id, run_id, "Completed", timestamp, passed_count, failed_count
        )

        logger.info(
            f"Run {run_id} finalized: {passed_count} passed, {failed_count} failed, "
            f"{skipped_count} skipped across {len(results)} cases"
        )

    except Exception as e:
        logger.exception(f"Failed to finalize run: {e}")
        _update_run_failed(evaluator_id, run_id, str(e))


def _aggregate_case(units: list[dict], pass_threshold: float = 0.8) -> dict:
    """Aggregate a case's repetition units into a single case result.

    - Score is the MEAN across non-skipped repetitions.
    - The case is "skipped" only if every repetition was skipped.
    - Pass = mean score >= the configured pass threshold (errored reps count
      as 0; a failed run is a failed result).
    - Representative input/expected/actual/reason come from the first
      repetition; every repetition's detail is preserved under "repetitions".

    Args:
        units: The (case, repetition) unit records for one test case.
        pass_threshold: Configured threshold on a 0.0-1.0 scale. Unit scores are
            stored as 0-100 percentages, so the comparison scales it by 100.
    """
    # Unit scores are percentages (0-100); the configured threshold is 0-1.
    threshold_pct = pass_threshold * 100

    units = sorted(units, key=lambda u: u.get("repeatIndex", 0))
    evaluations = [u.get("evaluation", {}) for u in units]
    first = evaluations[0] if evaluations else {}

    repetitions = []
    for u in units:
        ev = u.get("evaluation", {})
        repetitions.append(
            {
                "repeatIndex": u.get("repeatIndex", 0),
                "actualOutput": ev.get("actualOutput", ""),
                "score": ev.get("score", 0),
                "passed": ev.get("passed", False),
                "status": ev.get("status", "scored"),
                "reason": ev.get("reason", ""),
                "latencyMs": ev.get("latencyMs", 0),
            }
        )

    scored = [ev for ev in evaluations if ev.get("status") not in ("skipped", "error")]
    errored = [ev for ev in evaluations if ev.get("status") == "error"]

    if scored:
        # At least one repetition produced a real score. Errored reps count as
        # 0 (a failed run is a failed result), skipped reps are excluded.
        status = "scored"
        usable = scored + errored
        mean_score = sum(ev.get("score", 0) for ev in usable) / len(usable)
        passed = mean_score >= threshold_pct
    elif errored:
        # Every (non-skipped) repetition errored → the case errored.
        status = "error"
        mean_score = 0
        passed = False
    else:
        # Every repetition was skipped → the case is skipped.
        status = "skipped"
        mean_score = 0
        passed = False

    total_latency = sum(ev.get("latencyMs", 0) for ev in evaluations)

    # Structured per-evaluator breakdown, taken from the representative
    # repetition (rep 0) consistent with reason/actualOutput above. Per-evaluator
    # scores are stored on a 0.0-1.0 scale in evaluatorResults; convert scored
    # entries to the same 0-100 percentage scale used for the case/overall score.
    # Skipped/error entries have no meaningful score, so they carry None.
    evaluator_breakdown = []
    for r in first.get("evaluatorResults") or []:
        r_status = r.get("status")
        r_score = r.get("score")
        breakdown_score = (
            round(float(r_score) * 100, 1)
            if r_status == "scored" and isinstance(r_score, (int, float))
            else None
        )
        evaluator_breakdown.append(
            {
                "evaluatorType": r.get("type"),
                "score": breakdown_score,
                "passed": r.get("passed"),
                "status": r_status,
                "reason": r.get("reason"),
            }
        )

    return {
        "caseName": first.get("caseName"),
        "input": first.get("input"),
        "expectedOutput": first.get("expectedOutput"),
        "actualOutput": first.get("actualOutput"),  # representative (rep 0)
        "score": round(mean_score, 1),
        "passed": passed,
        "status": status,
        "reason": first.get("reason"),  # representative feedback (rep 0)
        "latencyMs": total_latency,
        "repeatCount": len(units),
        "repetitions": repetitions,
        # Structured per-evaluator scores/justifications for this case. The
        # combined `reason` string above is retained as the back-compat fallback.
        "evaluatorBreakdown": evaluator_breakdown,
    }


@tracer.capture_method
def _load_all_unit_results(evaluator_id: str, run_id: str) -> dict:
    """Load all unit result files from S3, grouped by test-case index."""
    grouped: dict = {}
    if not EVALUATIONS_BUCKET:
        return grouped

    prefix = f"evaluations/results/{evaluator_id}/{run_id}/"

    try:
        paginator = S3_CLIENT.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=EVALUATIONS_BUCKET, Prefix=prefix)

        for page in pages:
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith(".json"):
                    continue
                if key.endswith("aggregated_results.json"):
                    continue

                response = S3_CLIENT.get_object(Bucket=EVALUATIONS_BUCKET, Key=key)
                content = response["Body"].read().decode("utf-8")
                data = json.loads(content)
                case_index = int(data.get("testCaseIndex", 0))
                grouped.setdefault(case_index, []).append(data)

        unit_total = sum(len(v) for v in grouped.values())
        logger.info(
            f"Loaded {unit_total} unit results across {len(grouped)} cases from S3"
        )
        return grouped

    except ClientError as e:
        logger.error(f"Failed to load unit results: {e}")
        return grouped


@tracer.capture_method
def _save_aggregated_results(
    evaluator_id: str,
    run_id: str,
    results: list[dict],
    metrics: dict,
) -> str:
    """Save aggregated run results to S3 (run-scoped)."""
    if not EVALUATIONS_BUCKET:
        logger.warning("EVALUATIONS_BUCKET not configured, skipping S3 save")
        return ""

    s3_key = f"evaluations/results/{evaluator_id}/{run_id}/aggregated_results.json"

    results_data = {
        "evaluatorId": evaluator_id,
        "runId": run_id,
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


def _update_last_run_pointer(
    evaluator_id: str,
    run_id: str,
    status: str,
    timestamp: str,
    passed: int,
    failed: int,
) -> None:
    """Update the evaluator's denormalized last-run summary for the list view."""
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
    except ClientError as e:
        logger.warning(f"Failed to update last-run pointer: {e}")


def _update_run_failed(evaluator_id: str, run_id: str, error_message: str) -> None:
    """Update run status to Failed."""
    if not EVALUATOR_RUNS_TABLE:
        return

    timestamp = datetime.now(timezone.utc).isoformat()

    try:
        EVALUATOR_RUNS_TABLE.update_item(
            Key={"EvaluatorId": evaluator_id, "RunId": run_id},
            UpdateExpression="SET #s = :status, ErrorMessage = :error, CompletedAt = :completed",
            ExpressionAttributeNames={"#s": "Status"},
            ExpressionAttributeValues={
                ":status": "Failed",
                ":error": error_message,
                ":completed": timestamp,
            },
        )
    except ClientError as e:
        logger.error(f"Failed to update run status: {e}")
    _update_last_run_pointer(evaluator_id, run_id, "Failed", timestamp, 0, 0)


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
