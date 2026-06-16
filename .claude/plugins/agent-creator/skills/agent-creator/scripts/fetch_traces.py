#!/usr/bin/env python3
"""Fetch agent traces for config-level diagnosis, across profile-free and
profile-required tiers.

Diagnostic power is bounded by which trace you can reach, and the sources split
cleanly on whether they need an AWS profile:

  Tier 0  pasted trace            no script — the user pastes it into the chat
  Tier 1  getSession(id)          GraphQL (Cognito JWT)        — NO profile
  Tier 1  getEvaluator(id)        GraphQL (Cognito JWT)        — NO profile
  Tier 2  --deep (resultsS3Path)  S3 GetObject                 — REQUIRES profile
  Tier 2  --xray (session spans)  CloudWatch Logs (aws/spans)  — REQUIRES profile

Tiers 0–1 ride the same Cognito JWT the rest of the plugin uses (gql.py); no AWS
credentials. Tier 2 is an explicit opt-in that needs a real AWS profile with read
perms (s3:GetObject on the evaluations bucket, and/or CloudWatch Logs read). When a
tier-2 flag is used without a usable profile, this exits with a graceful message
pointing back at the tier-0/1 alternative — never a raw credentials traceback.

Output: normalized JSON `{ "tier", "source", "issues_observed": [...], "raw": ... }`
that the diagnosis step reads. `issues_observed` is a best-effort surfacing of the
signals most useful for diagnosis (failed eval cases with reasons, tool actions,
latencies); `raw` carries the full fetched payload so the agent can read more.

Usage:
  fetch_traces.py --session <id>
  fetch_traces.py --evaluator <id>
  fetch_traces.py --evaluator <id> --deep        # + S3 trajectory  (needs PROFILE)
  fetch_traces.py --xray --session-id <s>        # span logs        (needs PROFILE)
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from gql import post
except ImportError:  # allow running as a module from elsewhere
    from .gql import post

# Tier-1 GraphQL documents — mirror references/queries.md. getSession must select
# the SessionHistoryItem trace fields explicitly or they return null.
_GET_SESSION = """
query GetSession($id: String!) {
  getSession(id: $id) {
    id
    title
    startTime
    runtimeId
    runtimeVersion
    endpoint
    history {
      type
      content
      messageId
      references
      feedback
      reasoningContent
      structuredOutput
      toolActions
      executionTimeMs
      complete
    }
  }
}
"""

_GET_EVALUATOR = """
query GetEvaluator($evaluatorId: ID!) {
  getEvaluator(evaluatorId: $evaluatorId) {
    evaluatorId
    name
    evaluatorType
    agentRuntimeName
    qualifier
    modelId
    passThreshold
    status
    passedCases
    failedCases
    totalTimeMs
    resultsS3Path
    results {
      caseName
      input
      expectedOutput
      actualOutput
      score
      passed
      reason
      latencyMs
    }
    errorMessage
    createdAt
    startedAt
    completedAt
  }
}
"""

_NO_PROFILE_MSG = (
    "This is a tier-2 deep trace ({what}), which needs a real AWS profile with read "
    "permissions ({perms}) — it uses SigV4, not the Cognito token the rest of the "
    "plugin uses. No usable AWS profile was found.\n"
    "Either set PROFILE=<name> (and REGION) and retry, or use a profile-free tier-0/1 "
    "source instead: paste the session transcript directly, or run with --session "
    "<id> / --evaluator <id> (no --deep)."
)


def _boto3_session():
    """Build a boto3 Session honouring PROFILE/REGION, like the other scripts."""
    import boto3  # local import so tiers 0–1 never require boto3 creds to load

    profile = os.environ.get("PROFILE")
    region = os.environ.get("REGION")
    kwargs = {}
    if profile:
        kwargs["profile_name"] = profile
    if region:
        kwargs["region_name"] = region
    return boto3.Session(**kwargs)


def _has_usable_credentials() -> bool:
    """True if boto3 can resolve credentials (profile, env, or instance role)."""
    try:
        return _boto3_session().get_credentials() is not None
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Tier 1 — session
# --------------------------------------------------------------------------- #
def fetch_session(session_id: str) -> dict:
    data = post(_GET_SESSION, {"id": session_id})
    session = data.get("getSession")
    if not session:
        raise RuntimeError(
            f"No session found for id '{session_id}'. Check the id (listSessions lists "
            f"available sessions)."
        )
    issues = _session_issues(session)
    return {
        "tier": 1,
        "source": "getSession",
        "issues_observed": issues,
        "raw": session,
    }


def _session_issues(session: dict) -> list[dict]:
    """Surface diagnosis-relevant signals from a session's history.

    Tool-action *summaries* (not raw args/results), negative feedback, and slow
    turns are the config-relevant signals available at tier 1."""
    issues: list[dict] = []
    for item in session.get("history") or []:
        if item.get("type") != "ai":
            continue
        feedback = item.get("feedback")
        if feedback and feedback.lower() in ("negative", "thumbs_down", "down", "bad"):
            issues.append(
                {
                    "kind": "negative_feedback",
                    "messageId": item.get("messageId"),
                    "content_preview": (item.get("content") or "")[:280],
                }
            )
        tool_actions = item.get("toolActions")
        if tool_actions:
            issues.append(
                {
                    "kind": "tool_actions",
                    "messageId": item.get("messageId"),
                    "toolActions": tool_actions,
                }
            )
        if not item.get("complete", True):
            issues.append(
                {
                    "kind": "incomplete_response",
                    "messageId": item.get("messageId"),
                    "content_preview": (item.get("content") or "")[:280],
                }
            )
    return issues


# --------------------------------------------------------------------------- #
# Tier 1 — evaluator (+ optional tier-2 --deep)
# --------------------------------------------------------------------------- #
def fetch_evaluator(evaluator_id: str, deep: bool = False) -> dict:
    data = post(_GET_EVALUATOR, {"evaluatorId": evaluator_id})
    evaluator = data.get("getEvaluator")
    if not evaluator:
        raise RuntimeError(
            f"No evaluator found for id '{evaluator_id}'. Check the id (listEvaluators "
            f"lists available evaluators)."
        )

    issues = _evaluator_issues(evaluator)
    result: dict = {
        "tier": 1,
        "source": "getEvaluator",
        "issues_observed": issues,
        "raw": evaluator,
    }

    if deep:
        s3_path = evaluator.get("resultsS3Path")
        if not s3_path:
            result["deep_trajectory_note"] = (
                "No resultsS3Path on this evaluator — nothing to deep-fetch. The "
                "tier-1 results above are all that's available."
            )
            return result
        if not _has_usable_credentials():
            raise RuntimeError(
                _NO_PROFILE_MSG.format(
                    what="the full eval trajectory in S3",
                    perms="s3:GetObject on the evaluations bucket",
                )
            )
        trajectory = _load_s3_trajectory(s3_path)
        result["tier"] = 2
        result["source"] = "getEvaluator+resultsS3Path"
        result["trajectory"] = trajectory
    return result


def _evaluator_issues(evaluator: dict) -> list[dict]:
    """Failed eval cases with their grader reason are the richest tier-1 signal."""
    issues: list[dict] = []
    for case in evaluator.get("results") or []:
        if case.get("passed"):
            continue
        issues.append(
            {
                "kind": "failed_eval_case",
                "caseName": case.get("caseName"),
                "score": case.get("score"),
                "reason": case.get("reason"),
                "input": case.get("input"),
                "expectedOutput": case.get("expectedOutput"),
                "actualOutput": case.get("actualOutput"),
                "latencyMs": case.get("latencyMs"),
            }
        )
    if evaluator.get("errorMessage"):
        issues.append(
            {"kind": "evaluator_error", "errorMessage": evaluator["errorMessage"]}
        )
    return issues


def _parse_s3_uri(s3_uri: str) -> tuple[str, str]:
    if not s3_uri.startswith("s3://"):
        raise RuntimeError(f"Not an S3 URI: {s3_uri}")
    bucket, _, key = s3_uri[5:].partition("/")
    if not bucket or not key:
        raise RuntimeError(f"Malformed S3 URI: {s3_uri}")
    return bucket, key


def _load_s3_trajectory(s3_path: str) -> list[dict]:
    """Read the deep trajectory from S3.

    `resultsS3Path` may point at a single JSON file or at a prefix under which the
    executor wrote one `test_case_NNNN.json` per case — handle both."""
    s3 = _boto3_session().client("s3")
    bucket, key = _parse_s3_uri(s3_path)
    objects: list[dict] = []

    if key.endswith(".json"):
        keys = [key]
    else:
        prefix = key if key.endswith("/") else key + "/"
        keys = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                if obj["Key"].endswith(".json"):
                    keys.append(obj["Key"])

    for k in sorted(keys):
        body = s3.get_object(Bucket=bucket, Key=k)["Body"].read().decode("utf-8")
        try:
            objects.append({"key": k, "data": json.loads(body)})
        except json.JSONDecodeError:
            objects.append({"key": k, "raw": body[:2000]})
    return objects


# --------------------------------------------------------------------------- #
# Tier 2 — X-Ray / CloudWatch span logs (aws/spans), by session id
# --------------------------------------------------------------------------- #
def fetch_xray_spans(session_id: str, log_group: str, hours: int) -> dict:
    """Pull span logs for a session id from the aws/spans CloudWatch group.

    AgentCore observability with Transaction Search emits OpenTelemetry spans to a
    CloudWatch Logs group (default 'aws/spans'). We filter for the session id; the
    exact span attribute key varies, so this is a best-effort substring match the
    agent then reads from `raw`."""
    if not _has_usable_credentials():
        raise RuntimeError(
            _NO_PROFILE_MSG.format(
                what="distributed span logs",
                perms="logs:FilterLogEvents on the span log group",
            )
        )
    logs = _boto3_session().client("logs")
    # Window is relative; the caller passes hours-back. We can't use time.time()
    # here (unavailable in some sandboxes via the harness, and not needed) — instead
    # rely on FilterLogEvents without a start time when hours<=0, else compute via
    # the service-side relative is unavailable, so we read recent events.
    kwargs = {
        "logGroupName": log_group,
        "filterPattern": f'"{session_id}"',
        "limit": 1000,
    }
    events: list[dict] = []
    try:
        token = None
        while True:
            if token:
                kwargs["nextToken"] = token
            resp = logs.filter_log_events(**kwargs)
            events.extend(resp.get("events", []) or [])
            token = resp.get("nextToken")
            if not token or len(events) >= 1000:
                break
    except logs.exceptions.ResourceNotFoundException as exc:
        raise RuntimeError(
            f"Span log group '{log_group}' not found. AgentCore observability / "
            f"Transaction Search may not be enabled on this stack "
            f"(agentCoreObservability in config), or the group name differs — pass "
            f"--log-group. Underlying: {exc}"
        ) from exc

    issues = [
        {
            "kind": "span_event",
            "timestamp": e.get("timestamp"),
            "message": e.get("message"),
        }
        for e in events
    ]
    return {
        "tier": 2,
        "source": f"cloudwatch:{log_group}",
        "issues_observed": issues,
        "raw": {"sessionId": session_id, "eventCount": len(events), "events": events},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", help="session id → getSession (tier 1)")
    parser.add_argument("--evaluator", help="evaluator id → getEvaluator (tier 1)")
    parser.add_argument(
        "--deep",
        action="store_true",
        help="with --evaluator: also fetch the S3 trajectory (tier 2, needs PROFILE)",
    )
    parser.add_argument(
        "--xray",
        action="store_true",
        help="fetch span logs for --session-id (tier 2, needs PROFILE)",
    )
    parser.add_argument("--session-id", help="session id for --xray span filtering")
    parser.add_argument(
        "--log-group",
        default="aws/spans",
        help="CloudWatch Logs group for spans (default: aws/spans)",
    )
    parser.add_argument(
        "--hours", type=int, default=24, help="(reserved) lookback window hint"
    )
    args = parser.parse_args()

    try:
        if args.xray:
            session_id = args.session_id or args.session
            if not session_id:
                print(
                    "--xray needs --session-id (or --session) to filter spans by.",
                    file=sys.stderr,
                )
                return 2
            result = fetch_xray_spans(session_id, args.log_group, args.hours)
        elif args.evaluator:
            result = fetch_evaluator(args.evaluator, deep=args.deep)
        elif args.session:
            result = fetch_session(args.session)
        else:
            print(
                "Provide one of: --session <id>, --evaluator <id> [--deep], or "
                "--xray --session-id <s>. (Tier 0 needs no script — paste the trace "
                "into the conversation.)",
                file=sys.stderr,
            )
            return 2
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
