# agent-creator

A Claude Code plugin that creates and modifies **live AgentCore runtime agents** in a
**deployed** instance of this accelerator — the same agents you'd otherwise build by
clicking through the Agent Factory UI, driven instead from a conversation in your editor.

You describe what you want ("an orchestrator that consults an AWS-docs specialist and a
cost specialist, then writes the recommendation"); the plugin picks the right agentic
pattern, wires it from the building-blocks already in your running system (tools, MCP
servers, skills, existing agents), validates the config with parity to the server, and
submits it through the same GraphQL mutation the UI uses — polling until the runtime is
**Ready**.

> **This plugin talks to a *deployed* stack over the Agent Factory API.** It does **not**
> generate IaC. For build-time, baked-into-the-stack config (`config.yaml` / `tfvars`),
> use the `iac-config-generator` skill instead.

## When to use it

Invoke it (via `/agent-creator:agent-creator`, or just describe the task) when you want to:

- **Create** a new runtime agent — single, or a multi-agent orchestrator / swarm / graph.
- **Modify** a live agent — change its model or system prompt, add/remove tools, MCP
  servers, or skills.
- **Diagnose** a misbehaving agent from traces / eval output, and apply the config-level fix.
- **Author a skill** — a reusable, loadable instruction package an agent picks up at start,
  live with no redeploy.

## The four paths

| Path | You say… | What it does |
|---|---|---|
| **Create** | "build an agent that…" | Picks the architecture pattern, assembles from registries, validates, submits, polls to Ready. |
| **Modify** | "change the model on…", "remove skills from…" | Read–modify–write: fetches the **full** current config, changes only what you asked, re-submits the whole config as a new version. |
| **Diagnose** | "it picks the wrong tool, here are the traces" | Maps observed misbehavior to a config root cause, then applies the fix via the modify path. |
| **Author a skill** | "create a skill that teaches the agent to…" | CRUD on the live skill registry (S3) — no redeploy — then attaches the skill to an agent. |

## Architecture patterns it can build

The plugin classifies your request into one of four patterns (it decides — you don't have
to name it):

- **Single** — one agent, one job (tools + MCP + skills, optional structured output).
- **Agents as Tools** — a coordinator that delegates to specialist sub-agents it chooses at
  runtime.
- **Swarm** — peer agents that hand control to each other collaboratively, with emergent
  order.
- **Graph** — a fixed, author-defined workflow of nodes and edges with shared state.

Multi-agent patterns reference sub-agents that must already exist (and, for Agents-as-Tools
and Graph, have an **A2A twin**), so the plugin builds bottom-up: specialists first, the
coordinator last.

## What makes it safe to iterate

The server's config validation is strict and **silent** — a bad config is rejected by
returning an empty string with no reason. The plugin's local validator (`validate_config.py`)
has **parity with the server**, so problems are caught locally with an explanation instead
of as a silent server reject. And because there is no partial-update mutation, every
modification is a **full-config replacement** that mints a new version — which is why the
modify path always re-submits the whole config, never a patch.

> Every submit is validated and polled to Ready, but **not behaviorally tested** — static
> validation only. After a create or modify, run the agent in the UI to confirm it actually
> behaves as intended.

## How it's invoked

The plugin's scripts share Cognito auth and endpoint discovery against your deployed stack;
the first call prompts once for credentials and caches them in a gitignored `.env`. The
skill (`skills/agent-creator/SKILL.md`) drives the whole flow — you interact in natural
language and confirm before anything is submitted.

## Sample prompts

You don't name the architecture — the plugin infers it from the shape of what you describe.
The four prompts below each steer it toward a different pattern; use them as starting points.

**Single — one agent, one job:**

> "Create an agent that answers AWS questions from the official docs — it should search the
> documentation, cite a URL for every claim, and say so when the docs don't cover something."

**Agents as Tools — a coordinator that decides who to consult at runtime:**

> "Build something that, given a workload description, recommends an AWS architecture. One
> part digs through the AWS docs to pick services and cite best practices; another reasons
> about cost and sizing. Add a layer on top that decides which to consult, then writes up
> the final recommendation."

**Graph — a fixed pipeline, same steps every time:**

> "I want a fixed pipeline for AWS workload reviews. For every workload, always run a
> docs/architecture specialist and a cost specialist in parallel, then merge their two
> outputs into one combined recommendation. The steps never change."

**Swarm — peers that hand off collaboratively, no fixed order:**

> "Let a docs/architecture specialist and a cost specialist collaborate on AWS workload
> reviews with no fixed script — hand the problem back and forth, the cost one pushing back
> on anything too expensive, until they converge on a recommendation together."

Modify, diagnose, and skill-authoring requests are just as conversational — e.g. "remove the
skills from `pubmed_study_ideator`", "it keeps picking the wrong tool, here are the traces:
…", or "create a skill that teaches the agent PubMed search craft."

After a build, the plugin can suggest behavioral prompts to run the new agent against in the
UI — confirming it actually routes, merges, or hands off as intended before you rely on it.
