---
description: Turn a specs/<name>.yaml spec into an AI-DLC design-doc.md, entering the pipeline at the design phase (spec is already-refined requirements, so story/refine are skipped)
user_invocable: true
---

# /spec-design — spec → design doc (AI-DLC bridge)

Bridges a factory **spec** (`specs/<name>.yaml`) into the AI-DLC inception pipeline. A spec is not a rough idea — it is *already-refined requirements* (tools, inputs, outputs, errors, dependencies, deploy target all resolved). So this skill enters AI-DLC at **phase 3 (design)**, skipping `story-new` and `story-refine`, and produces a `design-doc.md` whose task map the existing `/tasks` skill then expands. Building is manual from those tasks.

The spec is the **source of truth**: this skill is re-runnable, and the design doc points back at the spec (not a `story.md`) as its authority. When the spec changes, re-run this skill to regenerate the design doc, then `/tasks`.

Pipeline position: **specs/\<name\>.yaml → /spec-design → design-doc.md → /tasks → tasks/ → (manual build) → /pr-draft**.

## Input

The spec name, e.g. `/spec-design pubmed` — reads `specs/pubmed.yaml`. Optional slug for the output folder (defaults to the spec name).

## Steps

1. **Read the spec** `specs/<name>.yaml`. If it is missing, STOP and list the specs under `specs/`. Parse its five layers: `server`, `dependencies`, `types`, `tools`, and each tool's inputs/constraints/output/errors/behavior. Also read `specs/SCHEMA-NOTES.md` if present — it records how spec fields map to code (e.g. a reserved word like `abstract` → `abstract_text`, `clamp` in core logic vs. `reject` at the input boundary).
2. **Resolve the target folder** `local/user-stories/<slug>/`. If a `design-doc.md` already exists, say so and confirm regeneration (the spec is source of truth, so regeneration is expected — but never clobber silently).
3. **Read the template** in `references/design-template.md` (bundled — a copy of the `/design-doc` template so output is identical in shape to a hand-run design phase). Match its section order exactly, so `/tasks` consumes it unchanged.
4. **Derive each section from the spec** (see the mapping below). Do not re-elicit requirements — translate what the spec already states into structure. Verify only the *how* (package versions, SDK API shapes) that the spec deliberately leaves to the engine; note the verification date. Do not invent versions from memory.
5. **Show the draft** design doc — especially the architecture and the task map — and confirm before writing. The task map is the contract `/tasks` expands, so it is the key gate.
6. **On confirmation**, write `local/user-stories/<slug>/design-doc.md` and suggest `/tasks <slug>`.

## Spec → design-doc mapping

Derive, don't elicit. Each design-doc section comes from spec fields:

| design-doc section | Comes from |
|---|---|
| **Goal & non-goals** | `server.description`; non-goals from `dependencies`/scope the spec omits, plus recorded ADR decisions (Runtime-only, stateless default). |
| **Architecture** | The **invariant spine** (the FastAPI app + AgentCore container contract: entrypoint, ARM64 Dockerfile, shared adapters from `src/agent-core/shared/`) + a **variant core** per the spec's `tools`/`types`/`dependencies`. Reuse the three-layer split: pure/IO core (no framework types) → tool/agent adapter → FastAPI transport spine. Draw the file tree from the tools and shared types. |
| **Key dependencies** | The spine set (`strands-agents`, `fastapi`/`uvicorn`, `pydantic`, AWS Lambda Powertools) + whatever `dependencies.outbound_http` implies (an HTTP client such as `httpx` for HTTP deps, a JSON/XML parser per `response_format`). State capabilities → concrete packages here; the spec stays capability-level. |
| **Task map** | The regular decomposition: **T1** scaffold (package layout + `pyproject`/deps), **T2** core (Pydantic types + per-tool logic, unit tests), **T3** tool/agent adapter (a `@tool` per spec tool + input models), **T4** FastAPI transport spine, **T5** integration test, **T6** ARM64 Dockerfile, **T7** README. Add a dependency/config task when `dependencies` is non-trivial (HTTP client + rate limit + response parsing), and capture-fixtures guidance when `response_format` is a structured format. |
| **Cross-cutting contract** | The AgentCore Runtime invariant (ARM64, FastAPI on `0.0.0.0:8080`, `/ws` + `/invocations` + `/ping`, stateless container per `server.stateful`, auth per `server.auth`) — restate and map each row to the task that enforces it. |
| **Decisions & open questions** | Decided items from the spec + linked ADRs (target, stateful, auth). Constraint modes (`clamp`/`reject`), `nullable` outputs, and computed fields become explicit decisions with the task that owns them. Flag anything the spec leaves genuinely open. |

## Definition of Done (in place of a story)

A spec has no `story.md`, so derive the DoD — the observable, testable outcomes every task maps to — directly from the spec and state it near the top of the design doc:

- One checkbox per `tool`: it appears in `tools/list` with the spec's input schema, and a representative call returns the spec's output shape.
- One checkbox per tool `error` case: the stated condition yields the stated model-facing message (surfaced as a tool error, per the framework's convention — not a success envelope).
- Constraints honored: `clamp` bounds applied in the core; `reject` inputs error before any side effect.
- The cross-cutting contract holds (builds ARM64; FastAPI serves `0.0.0.0:8080` with `/ws`+`/invocations`+`/ping`; stateless/stateful per spec).

Every task's Acceptance must cover at least one DoD checkbox; flag any gap rather than papering over it.

## Principles

- **Spec is source of truth.** The design doc references `specs/<name>.yaml` as its authority (a link at the top, in place of the usual `story.md` companion link). Re-running this skill after a spec change regenerates the doc.
- **Structure here, API surface in `/tasks`, implementation in the manual build.** Same rule as `/design-doc`: no function bodies in the design doc — only architecture, dependencies, and the task map.
- **Honor recorded decisions.** The spine is fixed by ADRs (where present); don't re-litigate CDK-vs-Terraform, Runtime-vs-Gateway, or stateless-default — reference the ADRs.
- **Thin over `/design-doc`.** This skill *is* the design phase for spec-driven work; it deliberately produces the same artifact shape so everything downstream (`/tasks`, build, `/pr-draft`) is unchanged.
