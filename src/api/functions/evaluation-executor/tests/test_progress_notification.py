# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Throttled progress notifications from `_update_progress`.

Units arrive one per Lambda invocation (`batchSize: 1`) across up to four
concurrent instances, so the throttle cannot hold state between units: it is
derived from the atomic post-increment count the update already returns. These
tests pin that derivation and the publish behaviour it drives.

Run with:
    pytest src/api/functions/evaluation-executor/tests -v
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

_CLIENT_ERROR = ClientError(
    {"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem"
)
_EVALUATOR_ID = "evaluator-1"
_RUN_ID = "run-1"
_ENDPOINT = "https://example.appsync-api.us-west-2.amazonaws.com/graphql"
_FAKE_ACCESS_KEY_ID = "fake-access-key-id"  # pragma: allowlist secret
_FAKE_SECRET_KEY = "fake/secret"  # pragma: allowlist secret


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
        yield importlib.import_module("index")


@pytest.fixture
def wiring(index_module):
    """Runs table and publisher recorded together, with finalize stubbed out."""
    recorder = MagicMock()
    with patch.multiple(
        index_module,
        EVALUATOR_RUNS_TABLE=recorder.runs_table,
        EVALUATIONS_TABLE=recorder.evaluations_table,
        publish_evaluation_update=recorder.publish,
        _finalize_run=recorder.finalize,
    ):
        yield SimpleNamespace(
            index=index_module,
            runs_table=recorder.runs_table,
            evaluations_table=recorder.evaluations_table,
            publish=recorder.publish,
            finalize=recorder.finalize,
        )


def _progress(wiring, completed: int, total: int, status: str = "Running") -> None:
    """Drive one `_update_progress` whose increment lands on `completed`."""
    wiring.runs_table.update_item.return_value = {
        "Attributes": {
            "CompletedUnits": completed,
            "TotalUnits": total,
            "Status": status,
        }
    }
    wiring.index._update_progress(_EVALUATOR_ID, _RUN_ID)


class TestMilestoneDerivation:
    """`_is_progress_milestone` is pure, so the step rule is asserted directly."""

    def test_step_scales_with_the_run_so_long_runs_do_not_notify_more(
        self, index_module
    ):
        for total in (50, 200, 1000):
            milestones = [
                c
                for c in range(1, total)
                if index_module._is_progress_milestone(c, total)
            ]
            assert len(milestones) <= index_module._PROGRESS_NOTIFY_STEPS

    def test_the_final_unit_is_never_a_milestone(self, index_module):
        # finalize publishes the terminal status itself, so a progress publish
        # there would be a duplicate carrying a stale status.
        for total in (1, 7, 10, 200):
            assert not index_module._is_progress_milestone(total, total)
            assert not index_module._is_progress_milestone(total + 1, total)

    def test_a_run_with_no_units_never_notifies(self, index_module):
        assert not index_module._is_progress_milestone(0, 0)
        assert not index_module._is_progress_milestone(1, 0)

    def test_every_unit_is_a_milestone_when_the_run_is_shorter_than_the_step(
        self, index_module
    ):
        # step floors at 1, so a 3-unit run reports each unit rather than none.
        assert [
            c for c in range(1, 3) if index_module._is_progress_milestone(c, 3)
        ] == [
            1,
            2,
        ]

    def test_milestones_are_evenly_spaced(self, index_module):
        total = 200
        step = total // index_module._PROGRESS_NOTIFY_STEPS
        assert [
            c for c in range(1, total) if index_module._is_progress_milestone(c, total)
        ] == list(range(step, total, step))


class TestPublishBehaviour:
    def test_a_milestone_publishes_the_run_status_and_no_counts(self, wiring):
        _progress(wiring, completed=20, total=200)

        wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Running")
        wiring.finalize.assert_not_called()

    def test_a_non_milestone_unit_publishes_nothing(self, wiring):
        _progress(wiring, completed=21, total=200)

        wiring.publish.assert_not_called()

    def test_the_last_unit_finalizes_instead_of_publishing_progress(self, wiring):
        _progress(wiring, completed=200, total=200)

        wiring.finalize.assert_called_once()
        # _finalize_run owns the terminal publish; it is stubbed here, so the
        # only way publish could fire is a duplicate progress notification.
        wiring.publish.assert_not_called()

    def test_a_publish_failure_does_not_fail_the_unit(self, wiring):
        wiring.publish.side_effect = RuntimeError("AppSync unreachable")

        _progress(wiring, completed=20, total=200)

        # the unit's own progress write already succeeded, so raising here would
        # re-run a completed unit and double-count it.
        wiring.runs_table.update_item.assert_called_once()

    def test_the_published_status_comes_from_the_row_not_a_literal(self, wiring):
        _progress(wiring, completed=20, total=200, status="Queued")

        wiring.publish.assert_called_once_with(_EVALUATOR_ID, _RUN_ID, "Queued")


class TestListViewProgress:
    """The evaluator pointer the manager table reads."""

    def test_a_milestone_advances_the_pointer_counters(self, wiring):
        _progress(wiring, completed=20, total=200)

        wiring.evaluations_table.update_item.assert_called_once()
        values = wiring.evaluations_table.update_item.call_args.kwargs[
            "ExpressionAttributeValues"
        ]
        assert values == {":cu": 20, ":tu": 200}

    def test_the_pointer_write_touches_only_the_counters(self, wiring):
        _progress(wiring, completed=20, total=200)

        expression = wiring.evaluations_table.update_item.call_args.kwargs[
            "UpdateExpression"
        ]
        # a mid-run write must not disturb the run id, status or timestamp the
        # pointer already holds.
        for attribute in ("LastRunId", "LastRunStatus", "LastRunAt"):
            assert attribute not in expression

    def test_a_non_milestone_unit_does_not_write_the_pointer(self, wiring):
        _progress(wiring, completed=21, total=200)

        wiring.evaluations_table.update_item.assert_not_called()

    def test_a_pointer_write_failure_does_not_fail_the_unit(self, wiring):
        wiring.evaluations_table.update_item.side_effect = _CLIENT_ERROR

        _progress(wiring, completed=20, total=200)

        # the unit's own progress write already succeeded; losing a list-view
        # refinement must not re-run it.
        wiring.publish.assert_called_once()
