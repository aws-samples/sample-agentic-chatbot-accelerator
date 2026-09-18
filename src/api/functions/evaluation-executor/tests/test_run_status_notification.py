# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Terminal-status notification at the executor's call sites (T2).

Complements test_appsync_publisher.py, which covers the publisher in isolation:
here the DynamoDB tables and the publisher are replaced on `index` so the two
terminal write paths can be driven end to end and the write/publish ordering
observed.

Run with:
    pytest src/api/functions/evaluation-executor/tests -v
"""

from __future__ import annotations

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.error import URLError

import appsync_publisher
import pytest
from botocore.exceptions import ClientError

_EVALUATOR_ID = "evaluator-1"
_RUN_ID = "run-1"
_ENDPOINT = "https://example.appsync-api.us-west-2.amazonaws.com/graphql"
_FAKE_ACCESS_KEY_ID = (
    "fake-access-key-id"  # pragma: allowlist secret  # not a credential
)
_FAKE_SECRET_KEY = "fake/secret"  # pragma: allowlist secret  # not a credential

_CLIENT_ERROR = ClientError(
    {"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem"
)


@pytest.fixture(scope="module")
def index_module():
    """Import `index` with a fake AWS environment; its clients are module-level."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("AWS_REGION", "us-west-2")
        mp.setenv("AWS_DEFAULT_REGION", "us-west-2")
        mp.setenv("AWS_ACCESS_KEY_ID", _FAKE_ACCESS_KEY_ID)
        mp.setenv("AWS_SECRET_ACCESS_KEY", _FAKE_SECRET_KEY)
        mp.setenv("APPSYNC_API_ENDPOINT", _ENDPOINT)
        mp.delenv("AWS_SESSION_TOKEN", raising=False)
        mp.delenv("AWS_PROFILE", raising=False)
        mp.delenv("EVALUATIONS_BUCKET", raising=False)
        yield importlib.import_module("index")


@pytest.fixture
def wiring(index_module):
    """Both tables and the publisher, recorded on one parent for call ordering."""
    recorder = MagicMock()
    recorder.runs_table.update_item.return_value = {}
    with patch.multiple(
        index_module,
        EVALUATOR_RUNS_TABLE=recorder.runs_table,
        EVALUATIONS_TABLE=recorder.evaluations_table,
        EVALUATIONS_BUCKET="",
        publish_evaluation_update=recorder.publish,
    ):
        yield SimpleNamespace(
            index=index_module,
            recorder=recorder,
            runs_table=recorder.runs_table,
            evaluations_table=recorder.evaluations_table,
            publish=recorder.publish,
        )


def _call_sequence(recorder: MagicMock) -> list[str]:
    """Recorded calls in order, minus the `__bool__` of each `if not TABLE` guard."""
    return [name for name, _, _ in recorder.mock_calls if "__" not in name]


def _persisted_status(update_item_call) -> str:
    return update_item_call.kwargs["ExpressionAttributeValues"][":status"]


def _pointer_status(update_item_call) -> str:
    return update_item_call.kwargs["ExpressionAttributeValues"][":st"]


def test_finalize_run_completes_when_the_publisher_raises(wiring):
    wiring.publish.side_effect = RuntimeError("appsync exploded")

    with patch.object(wiring.index.logger, "warning") as warning:
        assert wiring.index._finalize_run(_EVALUATOR_ID, _RUN_ID, {}) is None

    assert _persisted_status(wiring.runs_table.update_item.call_args) == "Completed"
    assert (
        _pointer_status(wiring.evaluations_table.update_item.call_args) == "Completed"
    )
    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Completed")

    assert warning.call_args.kwargs["extra"] == {
        "evaluatorId": _EVALUATOR_ID,
        "runId": _RUN_ID,
        "status": "Completed",
    }


def test_update_run_failed_completes_when_the_publisher_raises(wiring):
    wiring.publish.side_effect = RuntimeError("appsync exploded")

    assert wiring.index._update_run_failed(_EVALUATOR_ID, _RUN_ID, "boom") is None

    assert _persisted_status(wiring.runs_table.update_item.call_args) == "Failed"
    assert _pointer_status(wiring.evaluations_table.update_item.call_args) == "Failed"
    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Failed")


def test_publisher_failure_does_not_fail_the_unit_progress_path(wiring):
    wiring.runs_table.update_item.return_value = {
        "Attributes": {"CompletedUnits": 1, "TotalUnits": 1}
    }
    wiring.publish.side_effect = RuntimeError("appsync exploded")

    assert wiring.index._update_progress(_EVALUATOR_ID, _RUN_ID) is None

    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Completed")


def test_finalize_run_publishes_completed_after_both_writes(wiring):
    wiring.index._finalize_run(_EVALUATOR_ID, _RUN_ID, {})

    assert _call_sequence(wiring.recorder) == [
        "runs_table.update_item",
        "evaluations_table.update_item",
        "publish",
    ]
    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Completed")


def test_update_run_failed_publishes_failed_after_both_writes(wiring):
    wiring.index._update_run_failed(_EVALUATOR_ID, _RUN_ID, "boom")

    assert _call_sequence(wiring.recorder) == [
        "runs_table.update_item",
        "evaluations_table.update_item",
        "publish",
    ]
    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Failed")


def test_a_failed_finalize_publishes_only_the_failed_status(wiring):
    wiring.runs_table.update_item.side_effect = [_CLIENT_ERROR, {}]

    wiring.index._finalize_run(_EVALUATOR_ID, _RUN_ID, {})

    wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Failed")


def test_nothing_is_published_when_the_runs_table_is_unconfigured(wiring):
    with patch.object(wiring.index, "EVALUATOR_RUNS_TABLE", None):
        wiring.index._update_run_failed(_EVALUATOR_ID, _RUN_ID, "boom")

    wiring.publish.assert_not_called()
    wiring.evaluations_table.update_item.assert_not_called()


def test_finalize_run_posts_one_mutation_through_the_real_publisher(index_module):
    accepted = MagicMock()
    accepted.__enter__ = lambda self: self
    accepted.__exit__ = lambda *args: False
    accepted.read.return_value = b'{"data": {"publishEvaluationUpdate": {}}}'

    with patch.multiple(
        index_module,
        EVALUATOR_RUNS_TABLE=MagicMock(),
        EVALUATIONS_TABLE=MagicMock(),
        EVALUATIONS_BUCKET="",
    ):
        with patch("urllib.request.urlopen", return_value=accepted) as urlopen:
            index_module._finalize_run(_EVALUATOR_ID, _RUN_ID, {})

    body = json.loads(urlopen.call_args.args[0].data)
    assert body["variables"] == {
        "evaluatorId": _EVALUATOR_ID,
        "runId": _RUN_ID,
        "status": "Completed",
    }


def test_finalize_run_persists_the_run_when_the_endpoint_is_unset(
    index_module, monkeypatch
):
    monkeypatch.delenv("APPSYNC_API_ENDPOINT")
    runs_table = MagicMock()

    with patch.multiple(
        index_module,
        EVALUATOR_RUNS_TABLE=runs_table,
        EVALUATIONS_TABLE=MagicMock(),
        EVALUATIONS_BUCKET="",
    ):
        with patch("urllib.request.urlopen") as urlopen:
            assert index_module._finalize_run(_EVALUATOR_ID, _RUN_ID, {}) is None

    assert _persisted_status(runs_table.update_item.call_args) == "Completed"
    urlopen.assert_not_called()


def test_transport_failure_warning_carries_the_run_identifiers(monkeypatch):
    monkeypatch.setenv("APPSYNC_API_ENDPOINT", _ENDPOINT)
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", _FAKE_ACCESS_KEY_ID)
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", _FAKE_SECRET_KEY)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("AWS_PROFILE", raising=False)

    with patch("urllib.request.urlopen", side_effect=URLError("connection reset")):
        with patch.object(appsync_publisher.logger, "warning") as warning:
            appsync_publisher.publish_evaluation_update(
                _EVALUATOR_ID, _RUN_ID, "Failed"
            )

    assert warning.call_args.kwargs["extra"] == {
        "evaluatorId": _EVALUATOR_ID,
        "runId": _RUN_ID,
        "status": "Failed",
    }


def test_missing_endpoint_warns_on_every_call(monkeypatch):
    monkeypatch.delenv("APPSYNC_API_ENDPOINT", raising=False)

    with patch.object(appsync_publisher.logger, "warning") as warning:
        for _ in range(2):
            appsync_publisher.publish_evaluation_update(
                _EVALUATOR_ID, _RUN_ID, "Completed"
            )

    assert warning.call_count == 2
