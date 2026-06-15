---
name: agent-creator
description: Create and update AgentCore runtime agents in a DEPLOYED instance of this accelerator. Use whenever the user wants to create a new agent, build an orchestrator/swarm/graph agent, add or remove tools/MCP-servers/skills from an existing agent, change an agent's model or system prompt, or otherwise modify a live runtime agent via the Agent Factory API. NOT for generating IaC config.yaml/tfvars — that is iac-config-generator.
---

# Agent Creator

Create and update AgentCore runtime agents in a **live, deployed** accelerator. You
assemble a configuration from building-blocks that already exist in the running system,
validate it locally with parity to the server, and submit it through the same GraphQL
mutation the Agent Factory UI uses. The artifact is a validated config that becomes a
provisioned runtime — not prose, not IaC.

All scripts live in `scripts/`. Run them with the project's Python env (`uv run python
scripts/<name>.py …` from the repo root, or whatever invocation the user's environment
uses for the other plugin scripts). They share auth/endpoint discovery — the first call
prompts once for Cognito credentials and caches them in a gitignored `.env`.

## Phase 0 — Fork: create, modify, or redirect (decide first)

Read the user's phrasing and pick one branch before doing anything else:

- **Create** — "make a new agent", "build an orchestrator that…", "I need an agent for X"
  → the **Create path** below.
- **Modify** — "remove skills from agent XYZ", "change the model on my orchestrator",
  "add a tool to …" → the **Modify path** below. This is read-modify-write and has one
  rule that dominates everything (see there).
- **IaC redirect** — if the user wants a *build-time / baked-in* agent ("add this agent
  to config.yaml", "deploy a default agent with the stack") → **stop**. That is
  `iac-config-generator`'s job (edit config → redeploy). agent-creator only touches the
  **live runtime** via the API. Say so and point them there.

If the phrasing is ambiguous between create and modify, ask — the paths diverge
immediately.

## Create path — four phases

### Phase 1 — Capture intent & pick architecture

Interview the user, then drive the decision tree in
[references/architectures.md](references/architectures.md). The short version:

- one agent doing one job → **SINGLE**
- a coordinator delegating to specialist sub-agents → **AGENTS_AS_TOOLS**
- peer agents handing off collaboratively, no fixed order → **SWARM**
- a fixed multi-step workflow with branching/state → **GRAPH**

Capture: the model + inference params, the system prompt (`instructions`), the
conversation manager, whether the agent needs memory, and a rough capability list (which
becomes tools / MCP servers / skills in Phase 2). Don't over-interview — pick sensible
defaults (e.g. `sliding_window` conversation manager, `useMemory: false`) and tell the
user what you chose. The field-by-field shapes are in
[references/config-schemas.md](references/config-schemas.md).

### Phase 2 — Assemble from registries

Run `scripts/list_building_blocks.py` and **save its output to a file** — both you and
`validate_config.py` consume it. Map the user's capability list onto **existing** tools,
MCP servers, skills, and (for orchestrator / graph / swarm) existing runtime agents.

This is the real "writing" of an agent: wiring real, referenceable parts. If everything
the user needs already exists in the registries, **no Python is required** — assemble and
move to Phase 4. What each registry holds and how configs reference it is in
[references/registries.md](references/registries.md).

For orchestrator / graph patterns, note the **A2A-twin** requirement: a sub-agent can
only be referenced if it has an A2A twin runtime (`agentRuntimeArnA2A` is non-null in the
building-blocks `agents` list). `validate_config.py` enforces this; flag it here so the
user isn't surprised.

### Phase 3 — Scaffold custom Python (only if a block is missing)

If a needed tool / graph state class / deterministic node is **not** in the registry,
branch to [references/custom-code.md](references/custom-code.md) (task 07).

**Warn up front**, before scaffolding: this requires editing `src/agent-core/` and a
**full redeploy** before the agent can use the new block — it breaks the live-system
immediacy that makes this plugin fast. Always offer the alternative of picking an
existing block or reframing the capability. Only scaffold if the user accepts the
redeploy cost.

### Phase 4 — Validate & submit

1. Assemble the full config JSON for the chosen architecture.
2. `scripts/validate_config.py --config <file> --architecture <T> --building-blocks <Phase-2 file>`.
   Fix everything it flags — it has parity with the server, which otherwise rejects bad
   configs by silently returning `""`.
3. *(Optional)* spawn the [config-reviewer](agents/config-reviewer.md) subagent for a
   soft "is this any good" pass — does the prompt match the tools, are there unused
   tools, is the conversation manager appropriate. Advisory only.
4. Show the user the final config and get explicit confirmation. Then
   `scripts/submit_runtime.py --config <file> --architecture <T> --agent <name>`. It
   re-runs validation as a guard, submits, and **polls until the runtime is Ready** (the
   mutation is fire-and-forget — a return doesn't mean live).
5. Report the runtime summary it prints (id, version, ARNs, qualifier) and tell the user
   it's now visible in the UI. **Remind them this version was not behaviorally tested** —
   static validation only. Suggest a manual run in the UI before relying on it.

## Modify path (read-modify-write)

> **The one rule that dominates this path: fetch the FULL current config, change ONLY
> what the user asked, and re-submit the WHOLE config.** Never assemble a partial. An
> update is a full replacement that mints a new version — any field you omit is *wiped*.
> If the user says "remove skills", you fetch the whole config, drop the `skills` field,
> and submit everything else unchanged.

Steps:

1. `scripts/fetch_agent_config.py --agent XYZ` → the full current config + its
   `architectureType`. This is the canonical DEFAULT-qualifier config.
2. Show the user the current config and confirm the exact change ("remove skills" → drop
   `skills`; "change model" → edit `modelInferenceParameters.modelId`; "add tool Z" →
   append to `tools`, and add Z's entry to `toolParameters` if it needs params).
3. Apply the edit to the **in-memory full config** — keep every other field as-is.
4. `scripts/validate_config.py` on the modified full config (with building-blocks).
5. `scripts/submit_runtime.py --agent XYZ` → new version, polled to Ready.
6. *(Optional)* point an endpoint at the new version with `--tag <qualifier>` (DEFAULT
   advances automatically; this is only for additional qualifiers).

**Tag-match guard caveat** (see [references/update-semantics.md](references/update-semantics.md)):
if XYZ was created by a *different stack/environment*, the update is blocked server-side.
`submit_runtime.py` detects a terminal failure on an update and explains this — don't
present it as a raw error.

## Reference files

- [references/architectures.md](references/architectures.md) — the 4 patterns, the
  decision tree, and the config block each needs.
- [references/config-schemas.md](references/config-schemas.md) — the 4 config shapes
  field-by-field, each with a filled example. The human companion to `validate_config.py`.
- [references/registries.md](references/registries.md) — what each registry holds, how
  configs reference it, and which GraphQL query lists each.
- [references/update-semantics.md](references/update-semantics.md) — read-modify-write,
  full-config-not-patch, new-version-per-update, the tag-match guard, DEFAULT advancement.
- [references/queries.md](references/queries.md) — curated GraphQL documents and the
  schema field-shape traps (source of truth: `src/api/schema/schema.graphql`).
- [references/custom-code.md](references/custom-code.md) — scaffolding a missing tool /
  state class / deterministic node, with the redeploy warning (task 07).

## Why this design

The hard part of an agent here isn't prose — it's picking the right **architecture
pattern** and wiring **real registry building-blocks** into a config the server will
accept. The server's validation is unforgiving and *silent* (it returns `""` with no
reason), so local validation parity is the safety net that lets you iterate without
guessing. And because there's no separate update mutation, every modification is a
full-config replacement — which is why the modify path's full-config rule is stated so
emphatically: a careless partial silently destroys an agent's configuration.
