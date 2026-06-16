# Custom-code scaffolding — the escape hatch

The common case is pure assembly: everything the agent needs already exists in the
registries, zero Python. This file is for the **minority case** where a needed
building-block doesn't exist yet.

> ## ⚠️ Read this before scaffolding anything
>
> **Tools, graph state classes, and deterministic nodes live in the container image.
> Adding one requires editing `src/agent-core/` *and* `config.yaml`, then a full
> `make deploy` (rebuilds + redeploys the image) before the new block exists in the
> system.** This breaks agent-creator's whole premise of modifying a *live* runtime
> instantly — the agent that needs the new block cannot be created/updated until the
> redeploy finishes.
>
> Before going down this path: **offer the alternatives.** Can an existing block do the
> job? Can the capability be reframed onto an existing tool? Can it be an **MCP server**
> or **skill** instead (those add to a live system with *no redeploy* — see below)? Only
> scaffold container code if the user accepts the redeploy cost.
>
> And whatever you scaffold is a **stub with `TODO`s** — the wiring, not the business
> logic. Never tell the user a scaffolded tool is usable by a live agent until they've
> filled in the logic *and* redeployed.

## Route decision table

"I need capability X that isn't in the registry" → pick the route:

| Capability | Route | Where it lives | Redeploy? |
|---|---|---|---|
| A Python tool function | **New tool** | `src/agent-core/shared/base_registry.py` + `config.yaml` `toolRegistry` | **Yes** |
| Shared state for a graph workflow | **New state class** | `src/agent-core/docker-graph/src/states/` + `config.yaml` `stateClassRegistry` | **Yes** |
| A pure-Python graph step (no LLM) | **New deterministic node** | `src/agent-core/docker-graph/src/states/` + `config.yaml` `deterministicNodeRegistry` | **Yes** |
| External tool surface over MCP | **New MCP server** | `registerMcpServer` mutation (preferred) *or* `config.yaml` `mcpServerRegistry` | **No** via mutation |
| Reusable *expertise* (procedure / domain knowledge), not code | **New skill** | `manage_skill.py` (`createSkill`) → skills S3 bucket | **No** |

Route to the no-redeploy option whenever it fits the need. The redeploy warning below
applies **only** to routes 1–3 (tool / state class / deterministic node — code baked into
the container image). MCP servers and skills are live API operations with **no redeploy**.

**Skill vs. tool — the line that decides redeploy-or-not:** if the need is reusable
*procedure / domain knowledge / a rubric* the agent should follow → that's a **skill**
(loadable text, live, no redeploy — go to [skill-authoring.md](skill-authoring.md) /
task 09, *not* this file). If the need is to *execute code* (call an API, compute,
transform) → that's a **tool** (route 1 below, redeploy). This file is for the code cases.

---

## 1. New tool (redeploy)

A registry `Tool` entry is **inert** unless its name also has a `TOOL_FACTORY_MAP` entry
(verified in `base_registry.py:load_tools_from_dynamodb` — it only loads tools whose
`ToolName` is a key in the factory map; the sole exception is the built-in
`retrieve_from_kb` KB tool). So a live tool needs **all three** pieces — miss any one and
the tool silently never appears.

### (a) Implementation — `src/agent-core/shared/base_registry.py`

Simplest form is a `@tool` function (the file has a commented `get_weather_forecast`
example to mirror):

```python
from strands import tool  # already imported in this module

@tool(description="One-line description the model sees when choosing this tool.")
def my_new_tool(query: str) -> str:
    """Longer docstring: what it does, args, returns.

    Args:
        query: TODO describe the input.
    """
    # TODO: implement the real logic. This stub returns a placeholder.
    raise NotImplementedError("my_new_tool is a scaffold — implement before deploy.")
```

For a tool that needs configuration/clients at construction time, subclass
`AbstractToolObject` instead (see `RetrieverTool` in the same file) and expose a factory
method on `ToolFactory`.

### (b) Factory registration — `TOOL_FACTORY_MAP` (same file)

```python
TOOL_FACTORY_MAP = {
    # ...existing entries...
    "my_new_tool": lambda: my_new_tool,   # name MUST equal the toolRegistry name
}
```

For an `AbstractToolObject`, point the value at the `ToolFactory.create_*` staticmethod
that returns `tool_instance.tool`.

### (c) Registry seed — `config.yaml` `toolRegistry`

```yaml
toolRegistry:
    - name: my_new_tool          # MUST match the TOOL_FACTORY_MAP key exactly
      description: One-line description (also surfaced by listAvailableTools).
      invokesSubAgent: false      # true only for agents-as-tools / graph sub-agent tools
```

Then the agent's config references it as `tools: ["my_new_tool"]` (plus a
`toolParameters["my_new_tool"]` block if it takes params).

---

## 2. New graph state class (redeploy)

Simple graphs use the flat `stateSchema` (`dict[str,str]`). Register a `TypedDict` only
when you need reducers (fan-in accumulators, etc.). Mechanics live in
`docker-graph/src/state_registry.py`; real example: `states/mapreduce_example.py`.

### (a) Implementation — new module under `src/agent-core/docker-graph/src/states/`

```python
# states/my_pipeline.py
from __future__ import annotations
import operator
from typing import Annotated, TypedDict

from ..state_registry import register_state_class


def _last_value(_a, b):
    return b


class MyPipelineState(TypedDict):
    messages: Annotated[str, _last_value]      # text channel (graph framework needs it)
    # TODO: add your fields, with reducers where parallel branches fan in:
    # partials: Annotated[list[dict], operator.add]
    # result: dict


register_state_class(
    key="MyPipelineState",                     # used in GraphConfiguration.stateClass
    cls=MyPipelineState,
    label="My Pipeline",
    description="TODO describe the shared state.",
    fields=list(MyPipelineState.__annotations__.keys()),
)
```

### (b) Trigger registration — `states/__init__.py`

Registration only fires when the module is imported. Add it to the package `__init__`:

```python
from . import (  # noqa: F401 — triggers state + deterministic node registration
    mapreduce_example,
    my_pipeline,        # ← add this line
)
```

### (c) Registry seed — `config.yaml` `stateClassRegistry`

```yaml
stateClassRegistry:
    - key: "MyPipelineState"     # MUST match the register_state_class key
      label: "My Pipeline"
      description: "TODO describe the shared state."
      fields:
          - messages
          # - partials
          # - result
```

Referenced from a `GraphConfiguration` via `"stateClass": "MyPipelineState"`.

---

## 3. New deterministic graph node (redeploy)

A pure-Python graph step — no LLM, no I/O, same input → same output. It takes the state
dict and returns a **partial** state update. Mechanics: `deterministic_node_registry.py`;
real example: the `merge_template_partials` function in `states/mapreduce_example.py`.

Define it in the same kind of `states/` module (often alongside the state class it
operates on) and register it:

```python
from ..deterministic_node_registry import register_deterministic_node


def my_reduce_fn(state: dict) -> dict:
    """Deterministic node: TODO what it computes.

    State keys consumed: TODO
    State keys produced: TODO (a subset of the state fields; LangGraph merges it in)
    """
    # TODO: implement. Must be pure — no LLM calls, no external I/O.
    return {"messages": "TODO"}


register_deterministic_node(
    key="my_reduce_fn",                # used in a node's deterministicNodeKey
    fn=my_reduce_fn,
    label="My Reduce",
    description="TODO describe the deterministic step.",
)
```

Make sure its module is imported from `states/__init__.py` (same as above), and seed
`config.yaml`:

```yaml
deterministicNodeRegistry:
    - key: "my_reduce_fn"        # MUST match the register_deterministic_node key
      label: "My Reduce"
      description: "TODO describe the deterministic step."
```

Referenced from a graph node: `{ "id": "reduce", "deterministicNodeKey": "my_reduce_fn" }`.

---

## 4. New MCP server (NO redeploy — prefer this)

Register against the live system with the **`registerMcpServer`** mutation rather than
editing `config.yaml`'s `mcpServerRegistry` (which would need a redeploy). The UI's MCP
server manager uses the same mutation.

```graphql
mutation RegisterMcpServer(
  $name: String!, $authType: McpAuthType!, $runtimeId: String,
  $gatewayId: String, $qualifier: String, $mcpUrl: String, $description: String
) {
  registerMcpServer(
    name: $name, authType: $authType, runtimeId: $runtimeId,
    gatewayId: $gatewayId, qualifier: $qualifier, mcpUrl: $mcpUrl, description: $description
  ) { ... }   # AdminOpsResult — select its fields per the schema
}
```

`authType` ∈ `SIGV4 | NONE`. Provide a `runtimeId`+`qualifier` (AgentCore-hosted) **or**
an `mcpUrl` (external) depending on the server. After it succeeds, it shows up in
`list_building_blocks.py --filter mcpServers` immediately — reference it in
`mcpServers: ["name"]`.

## 5. New skill (NO redeploy) — go to the skill-authoring path

A skill is **not** custom code and does **not** belong on this redeploy page. If the need
is reusable *expertise* (a procedure, a domain rubric, search heuristics) rather than
executable code, it's a skill — authored live through `scripts/manage_skill.py`, no
redeploy, no editing of `src/agent-core/`.

→ **Use the Skill-authoring path in [SKILL.md](../SKILL.md) and
[skill-authoring.md](skill-authoring.md) (task 09).** That covers `manage_skill.py`
create/update/delete, the body-only/frontmatter-ownership rule, the merge-not-replace
contrast with agent updates, and attaching the skill to an agent via the modify path.

A new skill appears in `list_building_blocks.py --filter skills` immediately and is
referenceable in a SINGLE agent's `skills[]`.

---

## The redeploy workflow (routes 1–3 only)

1. Edit the `src/agent-core/` file(s) and add the `config.yaml` registry entry.
2. `make deploy` (rebuilds the affected container image via CodeBuild, then redeploys).
   This is **not** instant — it's a full build+deploy cycle.
3. Confirm the new block now appears in `list_building_blocks.py` (it reads the live
   registries).
4. **Only then** resume the create/modify flow that needs it.

State the redeploy requirement to the user *before* you scaffold (so they can opt for an
alternative) and *again after* (so they don't try to use the block before deploying).
