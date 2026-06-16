#!/usr/bin/env python3
"""Pre-submit validation gate with parity to the server-side resolver.

`createAgentCoreRuntime` (src/api/functions/agent-factory-resolver/index.py)
returns `""` *silently* on any validation failure — no GraphQL error, no reason.
A user who submits a bad config just gets an empty string back and no clue why.
This script reproduces the resolver's accept/reject decision locally and prints a
real, actionable message *before* the network round-trip.

Parity is kept automatic (not vendored) by importing the resolver's own Pydantic
models from the in-repo layer `src/shared/layers/python-sdk/genai_core`. The plugin
ships inside this repo, so the path is always present and the models never drift.

Two layers of checks:

  1. Pydantic parse against the architecture's model — this is exactly what the
     resolver does (AgentConfiguration / SwarmConfiguration / GraphConfiguration /
     AgentsAsToolsConfiguration). Catches missing fields, bad types, and the
     toolParameters↔tools consistency / graph-edge / entry-agent validators.

  2. Registry + A2A cross-checks — the resolver hits DynamoDB for these
     (A2A-twin lookups for AGENTS_AS_TOOLS and GRAPH); we mirror them against the
     JSON dumped by `list_building_blocks.py`. We additionally pre-check that every
     referenced tool / MCP server / skill / state class / deterministic node exists,
     which the resolver defers to runtime — catching at submit time what would
     otherwise be a live-agent failure. These checks need `--building-blocks`; without
     it they are skipped with a warning so the script still does pure schema validation
     offline.

Usage:
  python validate_config.py --config <path|-> --architecture SINGLE|SWARM|GRAPH|AGENTS_AS_TOOLS
      [--building-blocks <path>]
  → exit 0 + "OK" on success
  → exit non-zero + a numbered list of problems on failure
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# Import the resolver's Pydantic models straight from the in-repo SDK layer so
# validation stays byte-for-byte identical to the server. We locate the repo by
# walking up for the layer dir rather than hard-coding a depth, since the plugin
# can be invoked from anywhere.
# --------------------------------------------------------------------------- #
_SCRIPT_DIR = Path(__file__).resolve().parent
_LAYER_RELATIVE = Path("src/shared/layers/python-sdk")


def _find_sdk_layer() -> Path | None:
    for parent in _SCRIPT_DIR.parents:
        candidate = parent / _LAYER_RELATIVE
        if (candidate / "genai_core" / "api_helper" / "types.py").exists():
            return candidate
    return None


_SDK_LAYER = _find_sdk_layer()
if _SDK_LAYER and str(_SDK_LAYER) not in sys.path:
    sys.path.insert(0, str(_SDK_LAYER))

try:
    from genai_core.api_helper.types import (  # noqa: E402
        AgentConfiguration,
        AgentsAsToolsConfiguration,
        ArchitectureType,
        GraphConfiguration,
        SwarmConfiguration,
    )
    from pydantic import ValidationError  # noqa: E402
except ImportError as exc:  # pragma: no cover - environment problem, not config problem
    print(
        "Could not import the resolver's Pydantic models. Expected to find "
        f"{_LAYER_RELATIVE}/genai_core/api_helper/types.py by walking up from "
        f"{_SCRIPT_DIR}. Run from inside the accelerator repo and ensure pydantic "
        f"is installed (see requirements.txt). Underlying error: {exc}",
        file=sys.stderr,
    )
    raise SystemExit(2)


# Maps the architecture flag to the model the resolver dispatches to.
_MODEL_BY_ARCHITECTURE = {
    ArchitectureType.SINGLE.value: AgentConfiguration,
    ArchitectureType.SWARM.value: SwarmConfiguration,
    ArchitectureType.GRAPH.value: GraphConfiguration,
    ArchitectureType.AGENTS_AS_TOOLS.value: AgentsAsToolsConfiguration,
}


def _read_config(source: str) -> str:
    """Return the raw config JSON string from a path or stdin ('-')."""
    if source == "-":
        return sys.stdin.read()
    return Path(source).read_text()


def _format_pydantic_errors(exc: ValidationError, architecture: str) -> list[str]:
    """Turn a ValidationError into one human-readable line per problem."""
    problems = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "<root>"
        problems.append(
            f"{architecture} config invalid at '{loc}': {err['msg']} "
            f"(type={err['type']})"
        )
    return problems


# --------------------------------------------------------------------------- #
# Building-blocks helpers — the JSON shape produced by list_building_blocks.py:
#   {"tools": [...], "mcpServers": [...], "stateClasses": [...],
#    "deterministicNodes": [...], "skills": [...], "agents": [...]}
# --------------------------------------------------------------------------- #
def _index_names(entries: list[dict] | None, *keys: str) -> set[str]:
    """Collect identifier values from a registry list, trying each key in order."""
    names: set[str] = set()
    for entry in entries or []:
        for key in keys:
            value = entry.get(key)
            if value:
                names.add(value)
                break
    return names


def _check_membership(
    referenced: list[str] | None,
    available: set[str],
    field: str,
    kind: str,
    scaffold_hint: bool = False,
) -> list[str]:
    """Report any referenced name missing from `available`."""
    problems = []
    available_sorted = sorted(available)
    for i, name in enumerate(referenced or []):
        if name not in available:
            hint = (
                " Either pick an existing one or scaffold a new one (see custom-code)."
                if scaffold_hint
                else ""
            )
            problems.append(
                f"{field}[{i}] '{name}' is not in the {kind} registry. "
                f"Available: {available_sorted}.{hint}"
            )
    return problems


def _agent_twin_index(
    agents: list[dict] | None,
) -> tuple[dict[str, bool], dict[str, bool]]:
    """Build {agentName: has_a2a_twin} and {agentRuntimeId: has_a2a_twin} maps.

    AGENTS_AS_TOOLS references sub-agents by `runtimeId` (the HTTP runtime ID the
    UI surfaces); GRAPH references them by `agentName`. We index both ways so each
    architecture's check matches the same field the resolver does.
    """
    by_name: dict[str, bool] = {}
    by_runtime_id: dict[str, bool] = {}
    for agent in agents or []:
        has_twin = bool(agent.get("agentRuntimeArnA2A"))
        name = agent.get("agentName")
        runtime_id = agent.get("agentRuntimeId")
        if name:
            by_name[name] = has_twin
        if runtime_id:
            by_runtime_id[runtime_id] = has_twin
    return by_name, by_runtime_id


def _cross_check(architecture: str, config: dict, blocks: dict) -> list[str]:
    """Registry + A2A-twin cross-checks against the building-blocks data.

    Mirrors the DynamoDB lookups the resolver performs (A2A twins) and adds
    pre-checks for tool/MCP/skill/state/node existence that the resolver defers
    to runtime.
    """
    problems: list[str] = []

    tools = _index_names(blocks.get("tools"), "name")
    mcp_servers = _index_names(blocks.get("mcpServers"), "name")
    skills = _index_names(blocks.get("skills"), "name")
    state_classes = _index_names(blocks.get("stateClasses"), "key")
    det_nodes = _index_names(blocks.get("deterministicNodes"), "key")
    twin_by_name, twin_by_runtime_id = _agent_twin_index(blocks.get("agents"))

    if architecture == ArchitectureType.SINGLE.value:
        problems += _check_membership(
            config.get("tools"), tools, "tools", "tool", scaffold_hint=True
        )
        problems += _check_membership(
            config.get("mcpServers"), mcp_servers, "mcpServers", "MCP server"
        )
        problems += _check_membership(config.get("skills"), skills, "skills", "skill")

    elif architecture == ArchitectureType.AGENTS_AS_TOOLS.value:
        problems += _check_membership(
            config.get("tools"), tools, "tools", "tool", scaffold_hint=True
        )
        problems += _check_membership(
            config.get("mcpServers"), mcp_servers, "mcpServers", "MCP server"
        )
        for i, sub in enumerate(config.get("agentsAsTools") or []):
            runtime_id = sub.get("runtimeId", "")
            # An already-rewritten config carries the A2A twin ARN directly; the
            # resolver skips re-resolution for these, so we do too.
            if runtime_id.startswith("arn:"):
                continue
            if runtime_id not in twin_by_runtime_id:
                problems.append(
                    f"agentsAsTools[{i}] runtimeId '{runtime_id}' does not match any "
                    f"known runtime. Available runtime IDs: "
                    f"{sorted(twin_by_runtime_id)}."
                )
            elif not twin_by_runtime_id[runtime_id]:
                problems.append(
                    f"agentsAsTools[{i}] runtimeId '{runtime_id}' has no A2A twin "
                    f"runtime — the orchestrator invokes sub-agents over A2A. "
                    f"Recreate the sub-agent so its A2A twin is provisioned."
                )

    elif architecture == ArchitectureType.GRAPH.value:
        state_class = config.get("stateClass")
        if state_class and state_class not in state_classes:
            problems.append(
                f"stateClass '{state_class}' is not in the state-class registry. "
                f"Available: {sorted(state_classes)}."
            )
        for i, node in enumerate(config.get("nodes") or []):
            det_key = node.get("deterministicNodeKey")
            if det_key and det_key not in det_nodes:
                problems.append(
                    f"nodes[{i}].deterministicNodeKey '{det_key}' is not in the "
                    f"deterministic-node registry. Available: {sorted(det_nodes)}."
                )
            agent_name = node.get("agentName")
            if not agent_name:
                continue
            if agent_name not in twin_by_name:
                problems.append(
                    f"nodes[{i}].agentName '{agent_name}' references a non-existent "
                    f"agent. Available agents: {sorted(twin_by_name)}."
                )
            elif not twin_by_name[agent_name]:
                problems.append(
                    f"nodes[{i}].agentName '{agent_name}' has no A2A twin runtime — "
                    f"graph nodes call sub-agents over A2A. Recreate the agent so its "
                    f"A2A twin is provisioned."
                )

    elif architecture == ArchitectureType.SWARM.value:
        # The resolver does no swarm registry cross-check (entryAgent membership is
        # enforced by the Pydantic model). We additionally verify each referenced
        # agent actually exists as a runtime, which surfaces a typo'd reference
        # before the swarm fails to load it at runtime.
        ref_names = [
            ref.get("agentName")
            for ref in config.get("agentReferences") or []
            if ref.get("agentName")
        ]
        problems += _check_membership(
            ref_names, set(twin_by_name), "agentReferences", "runtime agent"
        )

    return problems


def validate_config(
    config_json: str, architecture: str, blocks: dict | None
) -> list[str]:
    """Return a list of problems; an empty list means the config is valid.

    `blocks` is the parsed building-blocks JSON, or None to skip registry/A2A
    cross-checks (pure schema validation only)."""
    model = _MODEL_BY_ARCHITECTURE.get(architecture)
    if model is None:
        return [
            f"Unknown architecture '{architecture}'. Expected one of: "
            f"{sorted(_MODEL_BY_ARCHITECTURE)}."
        ]

    # Parse first so we can give a JSON-specific message (mirrors the resolver's
    # JSONDecodeError branch) and so cross-checks have a dict to read.
    try:
        config_dict = json.loads(config_json)
    except json.JSONDecodeError as exc:
        return [f"Config is not valid JSON: {exc}"]

    # Layer 1 — exact resolver parity via the shared Pydantic model.
    try:
        model.model_validate_json(config_json)
    except ValidationError as exc:
        # A schema failure is also how the resolver rejects, so stop here: the
        # cross-checks below assume a well-formed config shape.
        return _format_pydantic_errors(exc, architecture)

    # Layer 2 — registry + A2A cross-checks (only when we have live data).
    if blocks is None:
        return []
    return _cross_check(architecture, config_dict, blocks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        required=True,
        help="path to the config JSON, or '-' to read from stdin",
    )
    parser.add_argument(
        "--architecture",
        default=ArchitectureType.SINGLE.value,
        choices=sorted(_MODEL_BY_ARCHITECTURE),
        help="architecture pattern (default: SINGLE, matching the resolver)",
    )
    parser.add_argument(
        "--building-blocks",
        help="path to list_building_blocks.py output for registry/A2A cross-checks. "
        "Omit to run pure schema validation offline.",
    )
    args = parser.parse_args()

    try:
        config_json = _read_config(args.config)
    except OSError as exc:
        print(f"Could not read config: {exc}", file=sys.stderr)
        return 2

    blocks: dict | None = None
    if args.building_blocks:
        try:
            blocks = json.loads(Path(args.building_blocks).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not read --building-blocks: {exc}", file=sys.stderr)
            return 2
    else:
        print(
            "Warning: --building-blocks not provided — skipping registry and A2A-twin "
            "cross-checks (tool/MCP/skill/state/node existence and sub-agent twins). "
            "Running pure schema validation only.",
            file=sys.stderr,
        )

    problems = validate_config(config_json, args.architecture, blocks)

    if not problems:
        print("OK")
        return 0

    print(
        f"Config validation failed ({len(problems)} problem"
        f"{'s' if len(problems) != 1 else ''}):",
        file=sys.stderr,
    )
    for i, problem in enumerate(problems, 1):
        print(f"  {i}. {problem}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
