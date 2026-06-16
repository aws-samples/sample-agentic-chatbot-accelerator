#!/usr/bin/env python3
"""Read back an existing agent's full runtime configuration (the read in
read-modify-write).

The update path re-submits the **whole** config minus whatever the user wants
changed — a partial re-submit would wipe every field it omits. So this script
returns the *complete* stored config, parsed and pretty-printed, alongside the
agent's `architectureType` (which the re-submit's createAgentCoreRuntime call
needs but the config-fetch queries don't carry).

Three source queries return the stored `ConfigurationValue` JSON string (a scalar
`String!` — no selection set):

  - getDefaultRuntimeConfiguration(agentName)            ← canonical "current config"
  - getRuntimeConfigurationByQualifier(agentName, qualifier)
  - getRuntimeConfigurationByVersion(agentName, agentVersion)

`architectureType` comes from listRuntimeAgents (RuntimeSummary), matched by name.

Query documents are duplicated here as constants; canonical form + field-shape
traps live in references/queries.md (sourced from src/api/schema/schema.graphql).

Read-only — issues no mutations.

Usage:
  fetch_agent_config.py --agent <name> [--qualifier DEFAULT | --version <v>]
  → prints {"agentName", "architectureType", "config": {...}} as JSON
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    from gql import post
except ImportError:  # allow running as a module from elsewhere
    from .gql import post

_GET_DEFAULT = """
query GetDefaultRuntimeConfiguration($agentName: String!) {
  getDefaultRuntimeConfiguration(agentName: $agentName)
}
"""

_GET_BY_QUALIFIER = """
query GetRuntimeConfigurationByQualifier($agentName: String!, $qualifier: String!) {
  getRuntimeConfigurationByQualifier(agentName: $agentName, qualifier: $qualifier)
}
"""

_GET_BY_VERSION = """
query GetRuntimeConfigurationByVersion($agentName: String!, $agentVersion: String!) {
  getRuntimeConfigurationByVersion(agentName: $agentName, agentVersion: $agentVersion)
}
"""

_LIST_AGENTS = """
query ListRuntimeAgents {
  listRuntimeAgents { agentName architectureType }
}
"""


def _fetch_architecture_type(agent_name: str) -> str | None:
    """Look up an agent's architectureType from the runtime summary list."""
    data = post(_LIST_AGENTS)
    for agent in data.get("listRuntimeAgents") or []:
        if agent.get("agentName") == agent_name:
            return agent.get("architectureType")
    return None


def fetch_agent_config(
    agent_name: str,
    qualifier: str | None = None,
    version: str | None = None,
) -> dict:
    """Return {agentName, architectureType, config} for an existing agent.

    Defaults to the DEFAULT qualifier (the canonical current config). Pass a
    qualifier or a version to read a specific endpoint/version instead. Raises
    RuntimeError on transport/GraphQL failure or when the config can't be found
    (the resolver returns "" for a missing agent/qualifier/version)."""
    if qualifier and version:
        raise RuntimeError("Pass at most one of --qualifier / --version, not both.")

    if version is not None:
        query, variables, field = (
            _GET_BY_VERSION,
            {"agentName": agent_name, "agentVersion": version},
            "getRuntimeConfigurationByVersion",
        )
    elif qualifier is not None and qualifier != "DEFAULT":
        query, variables, field = (
            _GET_BY_QUALIFIER,
            {"agentName": agent_name, "qualifier": qualifier},
            "getRuntimeConfigurationByQualifier",
        )
    else:
        query, variables, field = (
            _GET_DEFAULT,
            {"agentName": agent_name},
            "getDefaultRuntimeConfiguration",
        )

    data = post(query, variables)
    raw_config = data.get(field) or ""
    if not raw_config:
        target = (
            f"version {version}"
            if version is not None
            else f"qualifier {qualifier or 'DEFAULT'}"
        )
        raise RuntimeError(
            f"No configuration found for agent '{agent_name}' ({target}). "
            f"The agent, qualifier, or version may not exist — check "
            f"list_building_blocks.py --filter agents."
        )

    try:
        config = json.loads(raw_config)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Stored configuration for '{agent_name}' is not valid JSON: {exc}"
        ) from exc

    return {
        "agentName": agent_name,
        "architectureType": _fetch_architecture_type(agent_name),
        "config": config,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True, help="agent name")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--qualifier",
        help="tagged endpoint qualifier (default: DEFAULT — the current config)",
    )
    group.add_argument("--version", help="specific agent runtime version")
    args = parser.parse_args()

    try:
        result = fetch_agent_config(
            args.agent, qualifier=args.qualifier, version=args.version
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
