#!/usr/bin/env python3
"""Submit an agent config and poll until the runtime is actually Ready.

This is the only mutating script in the plugin. It does create *and* update —
the accelerator has no separate update mutation, so re-submitting under an
existing `agentName` mints a new version (read-modify-write; the caller fetched
and modified the full config first, see fetch_agent_config.py / task 06).

Why polling is mandatory: the resolver calls Step Functions fire-and-forget and
returns `agentName` the instant the SFN *starts*, not when the runtime is live.
A successful mutation return means "accepted & provisioning kicked off", not
"agent ready". The only real confirmation is polling RuntimeSummary.status
(via listRuntimeAgents) until it reaches Ready — or a terminal failure.

Status lifecycle (from the create-agentcore-runtime state machine):
  Creating → Ready            (success)
  Creating → "Create Failed"  (terminal failure — incl. the tag-match guard)
Status is a free-form String!, so we match it tolerantly (substring/case), not
against an enum.

Flow:
  1. Guard — run local validation (validate_config) first; refuse to submit on
     failure. The server rejects bad configs by returning "" with no error, so
     catching it locally is the only way to give a real reason.
  2. createAgentCoreRuntime(agentName, configValue, architectureType).
     A "" return is a hard failure (server-side validation) — explained, not
     silently treated as success.
  3. Poll listRuntimeAgents until status is Ready / terminal / timeout.

Usage:
  submit_runtime.py --config <path|-> --architecture SINGLE|SWARM|GRAPH|AGENTS_AS_TOOLS
      --agent <name> [--timeout 600] [--interval 10]
      [--tag <qualifier>] [--skip-validation]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

try:
    from gql import post
    from list_building_blocks import list_building_blocks
    from validate_config import validate_config
except ImportError:  # allow running as a module from elsewhere
    from .gql import post
    from .list_building_blocks import list_building_blocks
    from .validate_config import validate_config

_CREATE_MUTATION = """
mutation CreateAgentCoreRuntime(
  $agentName: String!
  $configValue: String!
  $architectureType: ArchitectureType
) {
  createAgentCoreRuntime(
    agentName: $agentName
    configValue: $configValue
    architectureType: $architectureType
  )
}
"""

_TAG_MUTATION = """
mutation TagAgentCoreRuntime(
  $agentName: String!
  $agentRuntimeId: String!
  $currentQualifierToVersion: String!
  $agentVersion: String!
  $qualifier: String!
  $description: String
) {
  tagAgentCoreRuntime(
    agentName: $agentName
    agentRuntimeId: $agentRuntimeId
    currentQualifierToVersion: $currentQualifierToVersion
    agentVersion: $agentVersion
    qualifier: $qualifier
    description: $description
  )
}
"""

_DEFAULT_TIMEOUT_SECONDS = 600
_DEFAULT_POLL_INTERVAL_SECONDS = 10


def _read_config(source: str) -> str:
    """Return the raw config JSON string from a path or stdin ('-')."""
    if source == "-":
        return sys.stdin.read()
    return Path(source).read_text()


# Full RuntimeSummary selection so the success report and version/tag logic have
# everything they need (the lean _LIST_AGENTS in fetch_agent_config only selects
# name + architectureType).
_RUNTIME_SUMMARY_QUERY = """
query ListRuntimeAgents {
  listRuntimeAgents {
    agentName
    agentRuntimeId
    agentRuntimeArnA2A
    numberOfVersion
    qualifierToVersion
    status
    architectureType
  }
}
"""


def _summary_for(agent_name: str) -> dict | None:
    """Return the RuntimeSummary for an agent, or None if it's not listed yet."""
    data = post(_RUNTIME_SUMMARY_QUERY)
    for summary in data.get("listRuntimeAgents") or []:
        if summary.get("agentName") == agent_name:
            return summary
    return None


def _is_ready(status: str) -> bool:
    return status.strip().lower() == "ready"


def _is_failed(status: str) -> bool:
    return "fail" in status.strip().lower()


def _validate(config_json: str, architecture: str) -> list[str]:
    """Run the local validation gate with live registry data when reachable.

    Falls back to schema-only validation (with a warning) if building-blocks
    can't be fetched, so a transient discovery hiccup doesn't block a submit
    whose schema is sound."""
    try:
        blocks = list_building_blocks()
    except RuntimeError as exc:
        print(
            f"Warning: could not fetch building-blocks for full validation "
            f"({exc}); running schema-only validation.",
            file=sys.stderr,
        )
        blocks = None
    return validate_config(config_json, architecture, blocks)


def submit_and_poll(
    agent_name: str,
    config_json: str,
    architecture: str,
    *,
    timeout: int = _DEFAULT_TIMEOUT_SECONDS,
    interval: int = _DEFAULT_POLL_INTERVAL_SECONDS,
    skip_validation: bool = False,
) -> dict:
    """Submit a config and block until the runtime is Ready.

    Returns the final RuntimeSummary on success. Raises RuntimeError with an
    actionable message on validation failure, server rejection, terminal SFN
    failure, or poll timeout."""
    # 1. Local validation gate.
    if not skip_validation:
        problems = _validate(config_json, architecture)
        if problems:
            raise RuntimeError(
                "Refusing to submit — local validation failed:\n"
                + "\n".join(f"  - {p}" for p in problems)
            )

    # Is this an update? Remember whether the agent already exists so a terminal
    # failure can point at the tag-match guard (the most likely update surprise).
    pre_existing = _summary_for(agent_name)
    is_update = pre_existing is not None

    # 2. Submit. createAgentCoreRuntime returns agentName, or "" on server-side
    # validation failure (no GraphQL error — that's why step 1 exists).
    data = post(
        _CREATE_MUTATION,
        {
            "agentName": agent_name,
            "configValue": config_json,
            "architectureType": architecture,
        },
    )
    returned = data.get("createAgentCoreRuntime")
    if not returned:
        raise RuntimeError(
            "Server rejected the config before provisioning (createAgentCoreRuntime "
            "returned an empty string — server-side validation failed). Run "
            "validate_config.py against this config and the live registry to see why."
        )

    print(
        f"Submitted '{agent_name}' ({architecture}); provisioning started. "
        f"Polling status every {interval}s (timeout {timeout}s)...",
        file=sys.stderr,
    )

    # 3. Poll until Ready / terminal / timeout. monotonic clock so a wall-clock
    # adjustment can't make the loop hang or exit early.
    deadline = time.monotonic() + timeout
    last_status = "<not yet listed>"
    while time.monotonic() < deadline:
        summary = _summary_for(agent_name)
        if summary is not None:
            last_status = summary.get("status", "")
            if _is_ready(last_status):
                return summary
            if _is_failed(last_status):
                raise RuntimeError(_terminal_failure_message(last_status, is_update))
        time.sleep(interval)

    raise RuntimeError(
        f"Timed out after {timeout}s — agent '{agent_name}' is still "
        f"'{last_status}'. Provisioning may be slow or the Step Function may have "
        f"failed silently. Check the create-agentcore-runtime Step Function "
        f"execution in the AWS console."
    )


def _terminal_failure_message(status: str, is_update: bool) -> str:
    """Explain a terminal failure status, flagging the tag-match guard on updates."""
    base = (
        f"Provisioning failed — agent reached terminal status '{status}'. "
        f"Check the create-agentcore-runtime Step Function execution in the console."
    )
    if is_update:
        return (
            base
            + "\nThis was an update to an existing agent. The most likely cause is "
            "the tag-match guard: you can only update agents whose Stack/Environment "
            "tags match the stack you're authenticated against. If this agent was "
            "created by a different stack/environment, the update is blocked."
        )
    return base


def _maybe_tag(summary: dict, qualifier: str) -> None:
    """Point a qualifier endpoint at the agent's newest version (opt-in)."""
    agent_name = summary["agentName"]
    agent_runtime_id = summary["agentRuntimeId"]
    # numberOfVersion is the just-minted latest version (String!).
    agent_version = summary["numberOfVersion"]
    current_qtv = summary.get("qualifierToVersion", "{}")
    print(
        f"Tagging qualifier '{qualifier}' → version {agent_version}...",
        file=sys.stderr,
    )
    data = post(
        _TAG_MUTATION,
        {
            "agentName": agent_name,
            "agentRuntimeId": agent_runtime_id,
            "currentQualifierToVersion": current_qtv,
            "agentVersion": agent_version,
            "qualifier": qualifier,
        },
    )
    if not data.get("tagAgentCoreRuntime"):
        raise RuntimeError(
            f"Endpoint tagging failed for qualifier '{qualifier}' — the runtime is "
            f"Ready, but the endpoint could not be created/pointed. Tag manually or "
            f"retry."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", required=True, help="config JSON path, or '-' for stdin"
    )
    parser.add_argument("--agent", required=True, help="agent name (create or update)")
    parser.add_argument(
        "--architecture",
        default="SINGLE",
        choices=["SINGLE", "SWARM", "GRAPH", "AGENTS_AS_TOOLS"],
        help="architecture pattern (default: SINGLE)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=_DEFAULT_TIMEOUT_SECONDS,
        help=f"max seconds to poll (default: {_DEFAULT_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=_DEFAULT_POLL_INTERVAL_SECONDS,
        help=f"seconds between polls (default: {_DEFAULT_POLL_INTERVAL_SECONDS})",
    )
    parser.add_argument(
        "--tag",
        help="after Ready, point this qualifier endpoint at the new version (opt-in)",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="skip the local validation gate (not recommended)",
    )
    args = parser.parse_args()

    try:
        config_json = _read_config(args.config)
    except OSError as exc:
        print(f"Could not read config: {exc}", file=sys.stderr)
        return 2

    try:
        summary = submit_and_poll(
            args.agent,
            config_json,
            args.architecture,
            timeout=args.timeout,
            interval=args.interval,
            skip_validation=args.skip_validation,
        )
        if args.tag:
            _maybe_tag(summary, args.tag)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Agent '{args.agent}' is Ready.", file=sys.stderr)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
