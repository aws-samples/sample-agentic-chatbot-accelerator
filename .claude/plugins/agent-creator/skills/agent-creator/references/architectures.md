# Architecture patterns & decision tree

Four architecture types, set by the `architectureType` argument to
`createAgentCoreRuntime` (`SINGLE | SWARM | GRAPH | AGENTS_AS_TOOLS`, default `SINGLE`).
Each maps to a different Pydantic config shape (see
[config-schemas.md](config-schemas.md)) and a different Docker container in
`src/agent-core/`. Pick the pattern *first* — it determines every field that follows.

## Decision tree

```
Is there more than one agent involved?
├─ No → SINGLE
│        One agent, one job. Tools + MCP + skills, optional structured output.
│        Most agents are this. Start here unless the user clearly needs multiple agents.
│
└─ Yes → How do the agents relate?
    ├─ One coordinator calls specialists as tools, decides who/when → AGENTS_AS_TOOLS
    │        The orchestrator is the only agent the user talks to; sub-agents are
    │        invisible "tools". The orchestrator's LLM chooses which to call.
    │
    ├─ Peers hand control to each other, no fixed order, collaborative → SWARM
    │        Agents pass the conversation between themselves until one finishes.
    │        Order emerges at runtime; there's an entry agent but no script.
    │
    └─ A fixed, author-defined flow of steps with branching / shared state → GRAPH
             A directed graph: nodes (agents or deterministic functions) wired by
             edges, possibly conditional. Use when the steps and their order are known
             up front (e.g. "research → draft → review → maybe revise → done").
```

Tie-breakers:

- **AGENTS_AS_TOOLS vs SWARM**: is there a clear boss? If one agent should stay in
  control and merely *delegate*, that's agents-as-tools. If the agents are peers that
  genuinely hand off ("now you take over"), that's a swarm.
- **SWARM vs GRAPH**: is the flow *emergent* (let the agents decide) or *prescribed*
  (the author knows the steps)? Emergent → swarm. Prescribed → graph.
- **When unsure, prefer SINGLE.** Multi-agent patterns add latency, cost, and failure
  surface. Only reach for them when one agent genuinely can't do the job.

## A2A-twin requirement (orchestrator & graph)

`AGENTS_AS_TOOLS` and `GRAPH` invoke their sub-agents over **A2A** (agent-to-agent).
Every referenced sub-agent must therefore have an **A2A twin runtime** — surfaced as a
non-null `agentRuntimeArnA2A` in `list_building_blocks.py`'s `agents` list. A sub-agent
without a twin cannot be referenced; the server rejects the config (and
`validate_config.py` catches it locally). If a needed sub-agent lacks a twin, recreate it
so the twin is provisioned. `SWARM` references agents by name/endpoint and does not
require a twin in the same way, but the referenced agents must still exist.

## Per-pattern config block (what's distinctive)

Full field lists and examples are in [config-schemas.md](config-schemas.md). The
distinguishing piece of each:

| Architecture | Model the resolver validates against | Distinctive field(s) |
|---|---|---|
| `SINGLE` | `AgentConfiguration` | `tools`, `toolParameters`, `mcpServers`, `skills`, optional `structuredOutput` |
| `AGENTS_AS_TOOLS` | `AgentsAsToolsConfiguration` | `agentsAsTools[]` (sub-agent `runtimeId` + `endpoint`); orchestrator's own `instructions` + model; optional extra `tools`/`mcpServers` |
| `SWARM` | `SwarmConfiguration` | `agentReferences[]` (agentName + endpointName), `entryAgent`, `orchestrator` (handoff/iteration limits) |
| `GRAPH` | `GraphConfiguration` | `nodes[]` (agent / deterministic / fork / dynamic_map), `edges[]` (optionally conditional), `entryPoint`, `stateSchema`/`stateClass`, `orchestrator` |

Notes that affect assembly:

- **AGENTS_AS_TOOLS** sub-agents are referenced by `runtimeId` (the HTTP runtime ID the
  UI surfaces). The server rewrites this to the A2A twin ARN at save time — you submit
  the HTTP id, not the ARN. On re-submit of an already-saved config the `runtimeId` may
  already be an ARN; that's fine (idempotent).
- **GRAPH** nodes come in kinds: an *agent* node (`agentName` set, invokes a runtime), a
  *deterministic* node (`deterministicNodeKey` set, pure-Python from the registry), a
  *fork* node, and a *dynamic_map* node. Only agent nodes need an A2A twin. Every
  non-terminal, non-dynamic_map node needs at least one outgoing edge; `__end__` is the
  terminal target. Custom state classes / deterministic nodes that don't exist yet
  require scaffolding (Phase 3 / [custom-code.md](custom-code.md)).
- **SWARM** `entryAgent` must be one of the `agentReferences[]` names (enforced by the
  model). Handoff/iteration/timeout limits live in `orchestrator` and have safe defaults.
