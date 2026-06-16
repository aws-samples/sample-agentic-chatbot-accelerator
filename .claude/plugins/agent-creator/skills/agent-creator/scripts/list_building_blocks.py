#!/usr/bin/env python3
"""Discover the registry building-blocks of a deployed accelerator stack.

The agent-creator workflow assembles agents from parts that already exist in the
live system — tools, MCP servers, graph state classes, deterministic nodes,
uploaded skills, and other runtime agents (for swarm refs / graph nodes /
agents-as-tools sub-agents). This script runs the same discovery queries the
Agent Factory UI uses and emits one consolidated JSON document:

  {
    "tools": [...], "mcpServers": [...], "stateClasses": [...],
    "deterministicNodes": [...], "skills": [...], "agents": [...]
  }

That document is consumed directly by `validate_config.py --building-blocks`: the
`agents` list carries `agentRuntimeArnA2A` per agent, which is the A2A-twin signal
the cross-checks rely on (a sub-agent without a twin can't be referenced by an
orchestrator or graph node).

Query documents are duplicated here as constants; their canonical form and the
field-shape traps live in references/queries.md, sourced from
src/api/schema/schema.graphql. Keep all three in sync.

Read-only — issues no mutations.

Usage:
  python list_building_blocks.py [--filter tools|mcpServers|stateClasses|
                                   deterministicNodes|skills|agents]
  → prints the consolidated (or single-category) JSON to stdout
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    from gql import post
except ImportError:  # allow running as a module from elsewhere
    from .gql import post

# Each category maps to (GraphQL document, resolver field name). The field name
# is the key AppSync returns the list under, inside the `data` object.
_QUERIES: dict[str, tuple[str, str]] = {
    "tools": (
        """
        query ListAvailableTools {
          listAvailableTools { name description invokesSubAgent }
        }
        """,
        "listAvailableTools",
    ),
    "mcpServers": (
        """
        query ListAvailableMcpServers {
          listAvailableMcpServers { name mcpUrl description authType source }
        }
        """,
        "listAvailableMcpServers",
    ),
    "stateClasses": (
        """
        query ListAvailableStateClasses {
          listAvailableStateClasses { key label description fields }
        }
        """,
        "listAvailableStateClasses",
    ),
    "deterministicNodes": (
        """
        query ListAvailableDeterministicNodes {
          listAvailableDeterministicNodes { key label description }
        }
        """,
        "listAvailableDeterministicNodes",
    ),
    "skills": (
        """
        query ListSkills {
          listSkills { name description s3Key lastModified }
        }
        """,
        "listSkills",
    ),
    # `agentRuntimeArnA2A` is nullable and is the A2A-twin signal validate_config
    # depends on — always selected here.
    "agents": (
        """
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
        """,
        "listRuntimeAgents",
    ),
}


def list_building_blocks(category: str | None = None) -> dict:
    """Return the consolidated building-blocks dict, or just one category.

    Raises RuntimeError (from gql.post) on transport/GraphQL failure."""
    categories = [category] if category else list(_QUERIES)
    result: dict[str, list] = {}
    for cat in categories:
        query, field = _QUERIES[cat]
        data = post(query)
        # A null list (no resolver data) becomes [] so downstream consumers and
        # the validator never have to special-case None.
        result[cat] = data.get(field) or []
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--filter",
        choices=sorted(_QUERIES),
        help="fetch just one category instead of all six",
    )
    args = parser.parse_args()

    try:
        blocks = list_building_blocks(args.filter)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(blocks, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
