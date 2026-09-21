# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Notification payload shape and swallowed failures in the publisher (T2).

`urllib.request.urlopen` is patched, so the request is signed for real (against
fake credentials from the environment) but never leaves the process.

Run with:
    pytest src/api/functions/evaluation-executor/tests -v
"""

from __future__ import annotations

import json
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import pytest
from appsync_publisher import publish_evaluation_update

_ENDPOINT = "https://example.appsync-api.us-west-2.amazonaws.com/graphql"
# Named rather than inlined so the scanner suppression sits on its own short line,
# as in test_judge_model_routing.py.
_FAKE_ACCESS_KEY_ID = (
    "fake-access-key-id"  # pragma: allowlist secret  # not a credential
)
_FAKE_SECRET_KEY = "fake/secret"  # pragma: allowlist secret  # not a credential
_EVALUATOR_ID = "evaluator-1"
_RUN_ID = "run-1"


@pytest.fixture(autouse=True)
def _publisher_env(monkeypatch):
    monkeypatch.setenv("APPSYNC_API_ENDPOINT", _ENDPOINT)
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", _FAKE_ACCESS_KEY_ID)
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", _FAKE_SECRET_KEY)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("AWS_PROFILE", raising=False)


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False


def _accepted() -> _FakeResponse:
    return _FakeResponse(
        json.dumps(
            {
                "data": {
                    "publishEvaluationUpdate": {
                        "evaluatorId": _EVALUATOR_ID,
                        "runId": _RUN_ID,
                        "status": "Completed",
                    }
                }
            }
        ).encode()
    )


def test_publishes_only_the_three_notification_fields():
    with patch("urllib.request.urlopen", return_value=_accepted()) as urlopen:
        assert publish_evaluation_update(_EVALUATOR_ID, _RUN_ID, "Completed") is True

    request = urlopen.call_args.args[0]
    body = json.loads(request.data)

    assert set(body) == {"query", "variables"}
    assert body["variables"] == {
        "evaluatorId": _EVALUATOR_ID,
        "runId": _RUN_ID,
        "status": "Completed",
    }
    assert "publishEvaluationUpdate" in body["query"]
    assert request.full_url == _ENDPOINT
    assert request.get_method() == "POST"
    assert request.get_header("Authorization", "").startswith("AWS4-HMAC-SHA256")


@pytest.mark.parametrize(
    "urlopen_kwargs",
    [
        pytest.param({"side_effect": URLError("connection reset")}, id="transport"),
        pytest.param(
            {
                "side_effect": HTTPError(
                    _ENDPOINT, 403, "Forbidden", {}, None  # type: ignore[arg-type]
                )
            },
            id="non-2xx",
        ),
        pytest.param(
            {
                "return_value": _FakeResponse(
                    b'{"errors": [{"errorType": "Unauthorized"}]}'
                )
            },
            id="graphql-errors",
        ),
    ],
)
def test_failures_return_false_without_raising(urlopen_kwargs):
    with patch("urllib.request.urlopen", **urlopen_kwargs):
        assert publish_evaluation_update(_EVALUATOR_ID, _RUN_ID, "Failed") is False


@pytest.mark.parametrize("endpoint", [None, "", "   "])
def test_missing_endpoint_is_a_no_op(monkeypatch, endpoint):
    if endpoint is None:
        monkeypatch.delenv("APPSYNC_API_ENDPOINT")
    else:
        monkeypatch.setenv("APPSYNC_API_ENDPOINT", endpoint)

    with patch("urllib.request.urlopen") as urlopen:
        assert publish_evaluation_update(_EVALUATOR_ID, _RUN_ID, "Completed") is False

    urlopen.assert_not_called()
