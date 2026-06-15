# Registries — the building-blocks an agent is assembled from

An agent config doesn't embed tool/skill/sub-agent code — it **references** entries that
already exist in the deployed system by name/key. `list_building_blocks.py` fetches all
of them in one consolidated JSON; `validate_config.py --building-blocks <that file>`
cross-checks every reference against it. This file says what each registry holds, how a
config points at it, and which GraphQL query lists it (full query docs:
[queries.md](queries.md)).

Consolidated output shape of `list_building_blocks.py`:

```json
{
  "tools": [...], "mcpServers": [...], "stateClasses": [...],
  "deterministicNodes": [...], "skills": [...], "agents": [...]
}
```

## The six registries

### `tools` — `listAvailableTools`
Python tool functions available to agents. Each: `name`, `description`, `invokesSubAgent`.
- **Referenced by:** `tools: ["name", ...]` in SINGLE / AGENTS_AS_TOOLS (and per-agent in
  swarm definitions). If a tool takes parameters, add `toolParameters: {"name": {...}}` —
  **every `toolParameters` key must be in `tools`.**
- `invokesSubAgent: true` tools are the agents-as-tools mechanism; they only make sense in
  orchestrator/graph contexts.
- Missing tool → scaffold one ([custom-code.md](custom-code.md)) + redeploy.

### `mcpServers` — `listAvailableMcpServers`
Model Context Protocol servers. Each: `name`, `mcpUrl`, `description`, `authType`
(`SIGV4` | `NONE`), `source` (`CDK` | `UI`).
- **Referenced by:** `mcpServers: ["name", ...]`.

### `skills` — `listSkills`
Uploaded skill folders (prose + scripts) the agent can load. Each: `name`, `description`,
`s3Key`, `lastModified`.
- **Referenced by:** `skills: ["name", ...]` (SINGLE).

### `agents` — `listRuntimeAgents`
Existing runtime agents — the parts that orchestrator/swarm/graph agents reference. Each:
`agentName`, `agentRuntimeId`, **`agentRuntimeArnA2A`** (null ⇒ no A2A twin),
`numberOfVersion`, `qualifierToVersion`, `status`, `architectureType`.
- **Referenced by:**
  - AGENTS_AS_TOOLS — `agentsAsTools[].runtimeId` (use `agentRuntimeId`).
  - SWARM — `agentReferences[].agentName`.
  - GRAPH — agent nodes' `agentName`.
- **A2A twin:** AGENTS_AS_TOOLS and GRAPH sub-agents must have a non-null
  `agentRuntimeArnA2A`. This is the single most common cross-check failure — check it
  during assembly, not after submit.

### `stateClasses` — `listAvailableStateClasses` (GRAPH only)
Registered shared-state classes for graph workflows. Each: `key`, `label`, `description`,
`fields`.
- **Referenced by:** `stateClass: "key"` in a GraphConfiguration (alternative to an
  ad-hoc `stateSchema`).
- Missing → scaffold ([custom-code.md](custom-code.md)) + redeploy.

### `deterministicNodes` — `listAvailableDeterministicNodes` (GRAPH only)
Registered pure-Python node functions for graph workflows. Each: `key`, `label`,
`description`.
- **Referenced by:** a node's `deterministicNodeKey: "key"`.
- Missing → scaffold ([custom-code.md](custom-code.md)) + redeploy.

## How `validate_config.py` uses this

With `--building-blocks`, it verifies (per architecture): tool / MCP / skill / state-class
/ deterministic-node names exist; AGENTS_AS_TOOLS `runtimeId`s exist **and have A2A
twins**; GRAPH agent nodes exist **and have A2A twins**; SWARM `agentReferences` exist.
Without `--building-blocks` it runs schema-only validation and warns that these
cross-checks were skipped. Always pass the file in Phase 4 / the modify path so a typo'd
or twin-less reference is caught locally instead of as a silent server `""`.
