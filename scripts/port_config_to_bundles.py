#!/usr/bin/env python3
# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Port existing agent configs from the runtime table into AgentCore bundles.

Standalone, re-runnable operator script. For every agent recorded in the
summary table it:

  1. resolves the current DEFAULT config from the legacy runtime config table
     (``agentCoreRuntimeCfgTable``);
  2. creates one AgentCore configuration bundle per agent — component keyed by
     the agent name, mirroring the deploy/runtime path (ADR-0002);
  3. backfills ``BundleId`` / ``BundleArn`` into the summary table and rewrites
     ``QualifierToVersion.DEFAULT`` to the bundle's versionId.

Idempotency is keyed on the summary row's ``BundleId``: if it is present and the
bundle still exists, the agent is skipped. This MUST be run and verified before
the CDK infra task (T8) removes the runtime config table.

Usage:
    python scripts/port_config_to_bundles.py --all [--dry-run]
    python scripts/port_config_to_bundles.py --agent my-agent --agent other
    python scripts/port_config_to_bundles.py --all --region us-east-1 --profile dev

Flags:
    --all                 Port every agent in the summary table.
    --agent NAME          Port only NAME (repeatable). Mutually exclusive with --all.
    --dry-run             Report intended actions without mutating anything.
    --full-history        Port every version of each agent (oldest->newest,
                          chained) instead of only the current DEFAULT version.
    --prefix PREFIX       Resource name prefix (default: env ACA_PREFIX). Tables
                          are ``<prefix>-agentCoreSummaryTable`` and
                          ``<prefix>-agentCoreRuntimeCfgTable``.
    --region REGION       AWS region (must be a bundle-supported region).
    --profile PROFILE     AWS named profile (prefer least-privilege creds).

Least privilege: run with scoped credentials (read the two tables, write the
summary table, create/get bundles) rather than admin — see the repo's global
production-safety rules.
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from pydantic import BaseModel

# Regions where configuration bundles are available (story §11). The script
# fails fast outside this set rather than emitting confusing API errors.
CONFIRMED_BUNDLE_REGIONS = {
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "ap-south-1",
    "ap-southeast-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ca-central-1",
}

BUNDLE_NAME_MAX = 100

# Bounded exponential backoff for throttled control-plane calls. No published
# per-account bundle quota exists, so we back off defensively rather than
# assume unlimited throughput.
_THROTTLE_CODES = {"ThrottlingException", "TooManyRequestsException"}
_MAX_RETRIES = 6
_BASE_DELAY_SECONDS = 0.5


class PortResult(BaseModel):
    """Outcome of porting a single agent."""

    agent_name: str
    bundle_id: Optional[str] = None
    bundle_arn: Optional[str] = None
    default_version_id: Optional[str] = None
    skipped: bool = False
    dry_run: bool = False
    error: Optional[str] = None


def sanitize_bundle_name(agent_name: str) -> str:
    """Derive a valid bundle name from an agent name.

    Mirrors ``put-config-bundle`` (T4) and the seeder (T7): non-word chars ->
    ``_``, ensure it starts with a letter, cap at ``BUNDLE_NAME_MAX``. Kept in
    sync by hand — see ``src/api/functions/put-config-bundle/index.py``.
    """
    import re

    sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", agent_name)
    if not sanitized or not sanitized[0].isalpha():
        sanitized = f"a_{sanitized}"
    return sanitized[:BUNDLE_NAME_MAX]


def _with_backoff(func, *args, sleep=time.sleep, **kwargs):
    """Call a control-plane function, retrying throttles with exponential backoff."""
    for attempt in range(_MAX_RETRIES):
        try:
            return func(*args, **kwargs)
        except ClientError as err:
            code = err.response.get("Error", {}).get("Code", "")
            if code in _THROTTLE_CODES and attempt < _MAX_RETRIES - 1:
                sleep(_BASE_DELAY_SECONDS * (2**attempt))
                continue
            raise
    raise RuntimeError("unreachable")  # pragma: no cover


def _bundle_exists(bac_client, bundle_id: str) -> bool:
    """True if the bundle still exists (idempotency probe)."""
    try:
        _with_backoff(bac_client.get_configuration_bundle, bundleId=bundle_id)
        return True
    except ClientError as err:
        if err.response.get("Error", {}).get("Code", "") == "ResourceNotFoundException":
            return False
        raise


def _get_summary_row(summary_table, agent_name: str) -> Optional[dict]:
    """Fetch an agent's summary row (or None)."""
    response = summary_table.get_item(Key={"AgentName": agent_name})
    return response.get("Item")


def _default_version(summary_row: dict) -> Optional[str]:
    """The current DEFAULT AgentRuntimeVersion recorded in the summary row."""
    return (summary_row.get("QualifierToVersion") or {}).get("DEFAULT")


def _config_rows_for_agent(runtime_table, agent_name: str) -> list[dict]:
    """All runtime config rows for an agent, oldest -> newest by CreatedAt."""
    rows: list[dict] = []
    kwargs = {
        "KeyConditionExpression": "AgentName = :name",
        "ExpressionAttributeValues": {":name": agent_name},
        "ScanIndexForward": True,  # ascending CreatedAt
    }
    response = runtime_table.query(**kwargs)
    rows.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = runtime_table.query(
            **kwargs, ExclusiveStartKey=response["LastEvaluatedKey"]
        )
        rows.extend(response.get("Items", []))
    return rows


def _select_rows(rows: list[dict], default_version: Optional[str], full_history: bool):
    """Pick which config rows to port.

    Current-only (default): the single row whose ``AgentRuntimeVersion`` matches
    the summary DEFAULT, else the newest row. Full-history: every row (already
    ordered oldest -> newest for correct parent chaining).
    """
    if full_history:
        return rows
    if default_version is not None:
        match = [r for r in rows if r.get("AgentRuntimeVersion") == default_version]
        if match:
            return match[:1]
    return rows[-1:]  # newest


def port_agent(
    agent_name: str,
    *,
    summary_table,
    runtime_table,
    bac_client,
    dry_run: bool = False,
    full_history: bool = False,
) -> PortResult:
    """Port one agent's config row(s) to a bundle and backfill the summary row.

    Idempotent: if the summary row already carries a ``BundleId`` and that bundle
    still exists, the agent is skipped (``skipped=True``) without creating a
    duplicate. Reuses the same create/version control-plane logic as T4.
    """
    summary_row = _get_summary_row(summary_table, agent_name)
    if summary_row is None:
        return PortResult(agent_name=agent_name, error="no summary row")

    existing_bundle_id = summary_row.get("BundleId")
    if existing_bundle_id and _bundle_exists(bac_client, existing_bundle_id):
        return PortResult(
            agent_name=agent_name,
            bundle_id=existing_bundle_id,
            bundle_arn=summary_row.get("BundleArn"),
            default_version_id=_default_version(summary_row),
            skipped=True,
        )

    default_version = _default_version(summary_row)
    rows = _config_rows_for_agent(runtime_table, agent_name)
    if not rows:
        return PortResult(
            agent_name=agent_name, error="no config rows in runtime table"
        )

    to_port = _select_rows(rows, default_version, full_history)

    if dry_run:
        return PortResult(
            agent_name=agent_name,
            default_version_id=default_version,
            dry_run=True,
        )

    bundle_id: Optional[str] = None
    bundle_arn: Optional[str] = None
    parent_version_id: Optional[str] = None
    default_version_id: Optional[str] = None

    for row in to_port:
        config_value = row["ConfigurationValue"]
        components = {
            agent_name: {"configuration": {"ConfigurationValue": config_value}}
        }
        if bundle_id is None:
            response = _with_backoff(
                bac_client.create_configuration_bundle,
                bundleName=sanitize_bundle_name(agent_name),
                components=components,
                clientToken=str(uuid.uuid4()),
                commitMessage="Ported from runtime config table",
            )
            bundle_id = response["bundleId"]
            bundle_arn = response["bundleArn"]
            version_id = response["versionId"]
        else:
            response = _with_backoff(
                bac_client.update_configuration_bundle,
                bundleId=bundle_id,
                components=components,
                parentVersionIds=[parent_version_id],
                clientToken=str(uuid.uuid4()),
                commitMessage="Ported from runtime config table (history)",
            )
            version_id = response["versionId"]

        parent_version_id = version_id
        if row.get("AgentRuntimeVersion") == default_version:
            default_version_id = version_id

    # Current-only, or a summary DEFAULT with no matching row: the bundle head is
    # the effective default.
    if default_version_id is None:
        default_version_id = parent_version_id

    _backfill_summary(
        summary_table,
        agent_name=agent_name,
        bundle_id=bundle_id,  # type: ignore[arg-type]
        bundle_arn=bundle_arn,  # type: ignore[arg-type]
        default_version_id=default_version_id,  # type: ignore[arg-type]
    )

    return PortResult(
        agent_name=agent_name,
        bundle_id=bundle_id,
        bundle_arn=bundle_arn,
        default_version_id=default_version_id,
        skipped=False,
    )


def _backfill_summary(
    summary_table,
    *,
    agent_name: str,
    bundle_id: str,
    bundle_arn: str,
    default_version_id: str,
) -> None:
    """Write BundleId/BundleArn and point QualifierToVersion.DEFAULT at the bundle."""
    summary_table.update_item(
        Key={"AgentName": agent_name},
        UpdateExpression=(
            "SET BundleId = :bid, BundleArn = :barn, "
            "QualifierToVersion.#default = :ver"
        ),
        ExpressionAttributeNames={"#default": "DEFAULT"},
        ExpressionAttributeValues={
            ":bid": bundle_id,
            ":barn": bundle_arn,
            ":ver": default_version_id,
        },
    )


def _iter_all_agents(summary_table) -> list[str]:
    """Every agent name in the summary table (paginated scan)."""
    names: list[str] = []
    response = summary_table.scan(ProjectionExpression="AgentName")
    names.extend(item["AgentName"] for item in response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = summary_table.scan(
            ProjectionExpression="AgentName",
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        names.extend(item["AgentName"] for item in response.get("Items", []))
    return names


def run(
    agent_names: list[str],
    *,
    summary_table,
    runtime_table,
    bac_client,
    dry_run: bool = False,
    full_history: bool = False,
) -> list[PortResult]:
    """Port the given agents and return per-agent results."""
    results: list[PortResult] = []
    for name in agent_names:
        try:
            results.append(
                port_agent(
                    name,
                    summary_table=summary_table,
                    runtime_table=runtime_table,
                    bac_client=bac_client,
                    dry_run=dry_run,
                    full_history=full_history,
                )
            )
        except ClientError as err:
            results.append(PortResult(agent_name=name, error=str(err)))
    return results


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--all", action="store_true", help="Port every agent.")
    scope.add_argument(
        "--agent", action="append", default=[], metavar="NAME", help="Port one agent."
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--full-history", action="store_true")
    parser.add_argument("--prefix", default=None)
    parser.add_argument("--region", default=None)
    parser.add_argument("--profile", default=None)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    """CLI entrypoint. Returns a process exit code."""
    import os

    args = _build_parser().parse_args(argv)

    prefix = args.prefix or os.environ.get("ACA_PREFIX")
    if not prefix:
        print("error: --prefix or ACA_PREFIX is required", file=sys.stderr)
        return 2

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    region = session.region_name
    if region not in CONFIRMED_BUNDLE_REGIONS:
        print(
            f"error: region {region!r} is not a confirmed bundle region "
            f"({', '.join(sorted(CONFIRMED_BUNDLE_REGIONS))})",
            file=sys.stderr,
        )
        return 2

    dynamodb = session.resource("dynamodb")
    summary_table = dynamodb.Table(f"{prefix}-agentCoreSummaryTable")
    runtime_table = dynamodb.Table(f"{prefix}-agentCoreRuntimeCfgTable")
    bac_client = session.client(
        "bedrock-agentcore-control", config=Config(retries={"mode": "standard"})
    )

    agent_names = _iter_all_agents(summary_table) if args.all else args.agent
    if not agent_names:
        print("No agents to port.")
        return 0

    mode = "DRY-RUN" if args.dry_run else "PORT"
    print(f"[{mode}] {len(agent_names)} agent(s) in {region} (prefix {prefix})")

    results = run(
        agent_names,
        summary_table=summary_table,
        runtime_table=runtime_table,
        bac_client=bac_client,
        dry_run=args.dry_run,
        full_history=args.full_history,
    )

    failures = 0
    for result in results:
        if result.error:
            failures += 1
            print(f"  ✗ {result.agent_name}: {result.error}")
        elif result.dry_run:
            print(
                f"  ~ {result.agent_name}: would port (DEFAULT={result.default_version_id})"
            )
        elif result.skipped:
            print(
                f"  = {result.agent_name}: already ported (bundle {result.bundle_id})"
            )
        else:
            print(
                f"  ✓ {result.agent_name}: bundle {result.bundle_id} "
                f"version {result.default_version_id}"
            )

    print(
        f"Done: {len(results) - failures} ok, {failures} failed "
        f"({sum(r.skipped for r in results)} skipped)."
    )
    return 1 if failures else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
