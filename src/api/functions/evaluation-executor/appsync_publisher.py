# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""SigV4-signed AppSync notifications for terminal evaluation-run status."""

from __future__ import annotations

import json
import os
import urllib.request

import boto3
from aws_lambda_powertools import Logger
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

logger = Logger(service="evaluation-executor")

_SERVICE = "appsync"
_TIMEOUT_SECONDS = 5
_MUTATION = """
mutation PublishEvaluationUpdate(
    $evaluatorId: String!
    $runId: String
    $status: String!
) {
    publishEvaluationUpdate(
        evaluatorId: $evaluatorId
        runId: $runId
        status: $status
    ) {
        evaluatorId
        runId
        status
    }
}
"""


def publish_evaluation_update(evaluator_id: str, run_id: str, status: str) -> bool:
    """Announce a run's terminal status over AppSync; never raise.

    Signs one `publishEvaluationUpdate` mutation with SigV4 and POSTs it to
    APPSYNC_API_ENDPOINT. Carries status only — subscribers re-read DynamoDB.

    Args:
        evaluator_id (str): Partition key of the run's evaluator.
        run_id (str): Sort key of the run whose status changed.
        status (str): Terminal status as persisted ("Completed" | "Failed").

    Returns:
        bool: True when AppSync accepted the mutation, False on any failure
            (missing endpoint, transport error, GraphQL `errors[]`), which is
            logged at warning level and swallowed.
    """
    log_context = {"evaluatorId": evaluator_id, "runId": run_id, "status": status}

    endpoint = os.environ.get("APPSYNC_API_ENDPOINT", "").strip()
    if not endpoint:
        logger.warning(
            "APPSYNC_API_ENDPOINT not configured, skipping notification",
            extra=log_context,
        )
        return False

    if not endpoint.startswith("https://"):
        logger.warning(
            f"APPSYNC_API_ENDPOINT is not an https endpoint, skipping notification: {endpoint}",
            extra=log_context,
        )
        return False

    body = json.dumps(
        {
            "query": _MUTATION,
            "variables": {
                "evaluatorId": evaluator_id,
                "runId": run_id,
                "status": status,
            },
        }
    )

    try:
        request = _sign(endpoint, body)
        # scheme is pinned to https above, so no file:/ or custom scheme reaches urlopen
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(
            request, timeout=_TIMEOUT_SECONDS
        ) as response:  # nosec B310
            payload = json.loads(response.read() or b"{}")
        # AppSync answers authorization and validation failures with HTTP 200 plus
        # an errors[] body.
        errors = payload.get("errors")
    except Exception as e:
        logger.warning(f"Failed to publish evaluation update: {e}", extra=log_context)
        return False

    if errors:
        logger.warning(
            f"AppSync rejected evaluation update: {errors}", extra=log_context
        )
        return False

    return True


def _sign(endpoint: str, body: str) -> urllib.request.Request:
    """Build a SigV4-signed POST of `body` to the AppSync GraphQL endpoint."""
    data = body.encode("utf-8")
    aws_request = AWSRequest(
        method="POST",
        url=endpoint,
        data=data,
        headers={"Content-Type": "application/json"},
    )

    credentials = boto3.Session().get_credentials().get_frozen_credentials()
    signer = SigV4Auth(credentials, _SERVICE, os.environ.get("AWS_REGION", ""))
    signer.add_auth(aws_request)

    return urllib.request.Request(
        endpoint,
        data=data,
        headers=dict(aws_request.headers),
        method="POST",
    )
