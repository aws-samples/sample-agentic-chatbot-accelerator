# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the port-config-to-bundles operator script."""

from unittest.mock import MagicMock

import port_config_to_bundles as port
import pytest
from botocore.exceptions import ClientError

CONFIG_V1 = '{"systemPrompt": "v1", "modelId": "anthropic.claude-x"}'
CONFIG_V2 = '{"systemPrompt": "v2", "modelId": "anthropic.claude-x"}'


def _not_found(op="GetConfigurationBundle"):
    return ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "gone"}}, op
    )


@pytest.fixture
def tables():
    summary = MagicMock(name="summary_table")
    runtime = MagicMock(name="runtime_table")
    bac = MagicMock(name="bac_client")
    return summary, runtime, bac


def _summary_row(**overrides):
    row = {"AgentName": "my-agent", "QualifierToVersion": {"DEFAULT": "2"}}
    row.update(overrides)
    return row


def _runtime_rows():
    return [
        {
            "AgentName": "my-agent",
            "CreatedAt": 100,
            "AgentRuntimeVersion": "1",
            "ConfigurationValue": CONFIG_V1,
        },
        {
            "AgentName": "my-agent",
            "CreatedAt": 200,
            "AgentRuntimeVersion": "2",
            "ConfigurationValue": CONFIG_V2,
        },
    ]


def test_create_path_ports_default_version(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {"Item": _summary_row()}
    runtime.query.return_value = {"Items": _runtime_rows()}
    bac.create_configuration_bundle.return_value = {
        "bundleId": "b-1",
        "bundleArn": "arn:b-1",
        "versionId": "ver-2",
    }

    result = port.port_agent(
        "my-agent", summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    # Only the DEFAULT (version "2") row is ported → single create, no update.
    bac.create_configuration_bundle.assert_called_once()
    bac.update_configuration_bundle.assert_not_called()
    kwargs = bac.create_configuration_bundle.call_args.kwargs
    assert kwargs["bundleName"] == "my_agent"  # hyphen -> underscore
    assert kwargs["components"] == {
        "my-agent": {"configuration": {"ConfigurationValue": CONFIG_V2}}
    }

    assert result.bundle_id == "b-1"
    assert result.default_version_id == "ver-2"
    assert result.skipped is False

    # Summary backfilled with bundle fields + DEFAULT pointer.
    values = summary.update_item.call_args.kwargs["ExpressionAttributeValues"]
    assert values[":bid"] == "b-1"
    assert values[":barn"] == "arn:b-1"
    assert values[":ver"] == "ver-2"


def test_idempotent_skip_when_bundle_exists(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {
        "Item": _summary_row(BundleId="b-1", BundleArn="arn:b-1")
    }
    # Bundle still exists → get succeeds.
    bac.get_configuration_bundle.return_value = {"bundleId": "b-1"}

    result = port.port_agent(
        "my-agent", summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    assert result.skipped is True
    assert result.bundle_id == "b-1"
    bac.create_configuration_bundle.assert_not_called()
    bac.update_configuration_bundle.assert_not_called()
    summary.update_item.assert_not_called()


def test_stale_bundle_id_reports_recreated(tables):
    summary, runtime, bac = tables
    # Summary claims a bundle, but it no longer exists → re-create, not skip.
    summary.get_item.return_value = {"Item": _summary_row(BundleId="ghost")}
    bac.get_configuration_bundle.side_effect = _not_found()
    runtime.query.return_value = {"Items": _runtime_rows()}
    bac.create_configuration_bundle.return_value = {
        "bundleId": "b-2",
        "bundleArn": "arn:b-2",
        "versionId": "ver-2",
    }

    result = port.port_agent(
        "my-agent", summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    assert result.skipped is False
    assert result.bundle_id == "b-2"
    bac.create_configuration_bundle.assert_called_once()


def test_dry_run_mutates_nothing(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {"Item": _summary_row()}
    runtime.query.return_value = {"Items": _runtime_rows()}

    result = port.port_agent(
        "my-agent",
        summary_table=summary,
        runtime_table=runtime,
        bac_client=bac,
        dry_run=True,
    )

    assert result.dry_run is True
    assert result.default_version_id == "2"
    bac.create_configuration_bundle.assert_not_called()
    summary.update_item.assert_not_called()


def test_full_history_chains_versions(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {"Item": _summary_row()}
    runtime.query.return_value = {"Items": _runtime_rows()}
    bac.create_configuration_bundle.return_value = {
        "bundleId": "b-1",
        "bundleArn": "arn:b-1",
        "versionId": "ver-1",
    }
    bac.update_configuration_bundle.return_value = {
        "bundleId": "b-1",
        "bundleArn": "arn:b-1",
        "versionId": "ver-2",
    }

    result = port.port_agent(
        "my-agent",
        summary_table=summary,
        runtime_table=runtime,
        bac_client=bac,
        full_history=True,
    )

    # v1 -> create, v2 -> update chained onto ver-1.
    bac.create_configuration_bundle.assert_called_once()
    bac.update_configuration_bundle.assert_called_once()
    upd = bac.update_configuration_bundle.call_args.kwargs
    assert upd["parentVersionIds"] == ["ver-1"]
    assert upd["components"] == {
        "my-agent": {"configuration": {"ConfigurationValue": CONFIG_V2}}
    }
    # DEFAULT (version "2") maps to the second bundle version.
    assert result.default_version_id == "ver-2"


def test_no_summary_row_reports_error(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {}

    result = port.port_agent(
        "my-agent", summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    assert result.error == "no summary row"
    bac.create_configuration_bundle.assert_not_called()


def test_no_config_rows_reports_error(tables):
    summary, runtime, bac = tables
    summary.get_item.return_value = {"Item": _summary_row()}
    runtime.query.return_value = {"Items": []}

    result = port.port_agent(
        "my-agent", summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    assert result.error == "no config rows in runtime table"


def test_backoff_retries_throttle_then_succeeds():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ClientError(
                {"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
                "CreateConfigurationBundle",
            )
        return "ok"

    sleeps = []
    result = port._with_backoff(flaky, sleep=sleeps.append)

    assert result == "ok"
    assert calls["n"] == 3
    assert len(sleeps) == 2  # backed off twice before the third success


def test_run_captures_per_agent_client_error(tables):
    summary, runtime, bac = tables
    summary.get_item.side_effect = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "GetItem"
    )

    results = port.run(
        ["a"], summary_table=summary, runtime_table=runtime, bac_client=bac
    )

    assert len(results) == 1
    assert results[0].error is not None


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("my-agent", "my_agent"),
        ("123agent", "a_123agent"),
        ("valid_Name1", "valid_Name1"),
    ],
)
def test_sanitize_bundle_name(raw, expected):
    assert port.sanitize_bundle_name(raw) == expected
