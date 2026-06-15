# Config schemas — field by field

The human companion to `validate_config.py`. Source of truth: the Pydantic models in
`src/shared/layers/python-sdk/genai_core/api_helper/types.py` (which `validate_config.py`
imports directly, so this file and the validator can't disagree on *rules* — but keep
this doc in sync when the models change). The `configValue` you submit is the
JSON-serialized form of one of these models, chosen by `architectureType`.

## Contents

- [Shared building blocks](#shared-building-blocks) — `ModelConfiguration`,
  `InferenceConfig`, `conversationManager`, `StructuredOutputFieldSpec`
- [SINGLE — `AgentConfiguration`](#single--agentconfiguration)
- [AGENTS_AS_TOOLS — `AgentsAsToolsConfiguration`](#agents_as_tools--agentsastoolsconfiguration)
- [SWARM — `SwarmConfiguration`](#swarm--swarmconfiguration)
- [GRAPH — `GraphConfiguration`](#graph--graphconfiguration)

---

## Shared building blocks

### `modelInferenceParameters` (`ModelConfiguration`)

```jsonc
{
  "modelId": "us.amazon.nova-2-lite-v1:0",   // Bedrock model id / inference profile
  "parameters": {                             // InferenceConfig
    "maxTokens": 3000,
    "temperature": 0.2,
    "stopSequences": null                     // optional list[str]
  },
  "reasoningBudget": null                      // optional: int (>=1024) OR "low"/"medium"/"high"
}
```

- `reasoningBudget`: omit / null = no reasoning. An integer (min 1024) for token-budget
  models, or a string effort level for effort-based models. Match it to the model family.

### `conversationManager` (`EConversationManagerType`)

One of `"null"` (no history), `"sliding_window"` (default — recent messages),
`"summarizing"` (summarize older messages). Default to `sliding_window` unless the user
has a reason otherwise.

### `structuredOutput` (`list[StructuredOutputFieldSpec]`, SINGLE only, optional)

Each field: `{ "name": "...", "pythonType": "str", "description": "...", "optional": false }`.
`pythonType` is a string like `"str"`, `"int"`, `"list[str]"`. Use when the agent must
return machine-parseable fields rather than free text.

---

## SINGLE — `AgentConfiguration`

| Field | Type | Required | Notes |
|---|---|---|---|
| `modelInferenceParameters` | `ModelConfiguration` | ✅ | see above |
| `instructions` | `str` | ✅ | the system prompt |
| `tools` | `list[str]` | ✅ (may be `[]`) | tool-registry names |
| `toolParameters` | `dict[str, dict]` | ✅ (may be `{}`) | **every key must be a name in `tools`** |
| `mcpServers` | `list[str]` | ✅ (may be `[]`) | MCP-registry names |
| `conversationManager` | enum | default `sliding_window` | |
| `useMemory` | `bool` | default `false` | attach AgentCore Memory |
| `skills` | `list[str]` | default `[]` | skill names |
| `structuredOutput` | `list[StructuredOutputFieldSpec]` | optional | |
| `description` | `str` | optional | shown to other agents over A2A (agent-card description) |

```json
{
  "modelInferenceParameters": {
    "modelId": "us.amazon.nova-2-lite-v1:0",
    "parameters": { "maxTokens": 3000, "temperature": 0.2, "stopSequences": null },
    "reasoningBudget": null
  },
  "instructions": "Analyze the given topic from an economic perspective.",
  "tools": [],
  "toolParameters": {},
  "mcpServers": [],
  "conversationManager": "sliding_window",
  "useMemory": false,
  "skills": [],
  "structuredOutput": null,
  "description": "Handles analysis from an economic point of view"
}
```

**Validator:** every `toolParameters` key must appear in `tools` — else
`toolParameters keys {…} not found in tools`.

---

## AGENTS_AS_TOOLS — `AgentsAsToolsConfiguration`

The orchestrator. `agentsAsTools[]` are sub-agents exposed to it as tools.

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentsAsTools` | `list[AgentAsToolReference]` | ✅ (≥1) | each `{ "runtimeId": "...", "endpoint": "..." }` |
| `modelInferenceParameters` | `ModelConfiguration` | ✅ | orchestrator's model |
| `instructions` | `str` (non-empty) | ✅ | orchestrator's system prompt |
| `tools` | `list[str]` | optional | extra non-agent tools |
| `toolParameters` | `dict[str, dict]` | optional | |
| `mcpServers` | `list[str]` | optional | |
| `conversationManager` | enum | default `sliding_window` | |
| `useMemory` | `bool` | default `false` | |

```json
{
  "agentsAsTools": [
    { "runtimeId": "economical_analyst-aMBZbUFDFd", "endpoint": "DEFAULT" },
    { "runtimeId": "creative_writer-Mk7vps6n4i", "endpoint": "DEFAULT" }
  ],
  "modelInferenceParameters": {
    "modelId": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "parameters": { "maxTokens": 4096, "temperature": 0.3 }
  },
  "instructions": "You coordinate specialists. Delegate analysis to the economical_analyst and prose to the creative_writer; synthesize their outputs.",
  "tools": null,
  "toolParameters": null,
  "mcpServers": null,
  "useMemory": false
}
```

**Validators:** `tools` and `toolParameters` must both be present or both omitted; any
`toolParameters` key must be in `tools`. Each `runtimeId` must resolve to a runtime with
an **A2A twin** (the server rewrites `runtimeId` → A2A ARN; missing twin = rejection).
Submit the HTTP `runtimeId`, not the ARN.

---

## SWARM — `SwarmConfiguration`

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentReferences` | `list[AgentReference]` | ✅ (≥1) | each `{ "agentName": "...", "endpointName": "..." }` |
| `entryAgent` | `str` | ✅ | **must be one of the `agentReferences` names** |
| `orchestrator` | `SwarmOrchestratorConfig` | default | handoff/iteration/timeout limits |
| `conversationManager` | enum | default `sliding_window` | |

`orchestrator` defaults: `maxHandoffs=20`, `maxIterations=20`,
`executionTimeoutSeconds=900`, `nodeTimeoutSeconds=300`,
`repetitiveHandoffDetectionWindow=8`, `repetitiveHandoffMinUniqueAgents=3`. Constraints:
`nodeTimeoutSeconds ≤ executionTimeoutSeconds`; `detectionWindow > minUniqueAgents`.

```json
{
  "agentReferences": [
    { "agentName": "economical_analyst", "endpointName": "DEFAULT" },
    { "agentName": "creative_writer", "endpointName": "DEFAULT" }
  ],
  "entryAgent": "economical_analyst",
  "orchestrator": {
    "maxHandoffs": 20, "maxIterations": 20,
    "executionTimeoutSeconds": 900.0, "nodeTimeoutSeconds": 300.0,
    "repetitiveHandoffDetectionWindow": 8, "repetitiveHandoffMinUniqueAgents": 3
  },
  "conversationManager": "sliding_window"
}
```

**Validators:** `entryAgent` ∈ `agentReferences` names; reference names unique; the
`orchestrator` timeout/window constraints above.

---

## GRAPH — `GraphConfiguration`

| Field | Type | Required | Notes |
|---|---|---|---|
| `nodes` | `list[GraphNodeDefinition]` | ✅ (≥1) | see node kinds below |
| `edges` | `list[GraphEdgeDefinition]` | default `[]` | `{ "source", "target", "condition?" }` |
| `entryPoint` | `str` | ✅ | **must be a node id** |
| `stateSchema` | `dict[str,str]` | default `{}` | ad-hoc shared-state fields |
| `stateClass` | `str` | optional | a registered state class key (instead of `stateSchema`) |
| `orchestrator` | `GraphOrchestratorConfig` | default | `maxIterations=50`, `executionTimeoutSeconds=300`, `nodeTimeoutSeconds=60` |

**Node kinds** (`GraphNodeDefinition`, mutually exclusive identity):

- **Agent node** — `agentName` set (+ `endpointName`, default `"DEFAULT"`). Invokes a
  runtime; needs an A2A twin.
- **Deterministic node** — `deterministicNodeKey` set; a registered pure-Python function.
- **Fork node** — `nodeType: "fork"`; pass-through fan-out.
- **Dynamic map node** — `nodeType: "dynamic_map"` (+ `dynamicMapConfig`); `Send()`-based
  fan-out. Handles its own outgoing edges.

Optional per node: `label`, `promptTemplate` (with `{variable}` placeholders).

```json
{
  "nodes": [
    { "id": "research", "agentName": "economical_analyst", "endpointName": "DEFAULT" },
    { "id": "write", "agentName": "creative_writer", "endpointName": "DEFAULT" }
  ],
  "edges": [
    { "source": "research", "target": "write" },
    { "source": "write", "target": "__end__" }
  ],
  "entryPoint": "research",
  "stateSchema": {},
  "orchestrator": { "maxIterations": 50, "executionTimeoutSeconds": 300.0, "nodeTimeoutSeconds": 60.0 }
}
```

**Validators:** node ids unique; `entryPoint` is a node id; every edge `source` is a node
and `target` is a node or `__end__`; every non-terminal, non-`dynamic_map` node has ≥1
outgoing edge; `nodeTimeoutSeconds ≤ executionTimeoutSeconds`. Plus the server checks
every agent node references an existing agent **with an A2A twin**.
