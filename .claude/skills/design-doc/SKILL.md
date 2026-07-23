---
description: Generate a high-level design doc + task map from an approved story.md
user_invocable: true
---

# /design-doc — architecture + task map

Step 3 of the AI-DLC pipeline. Turns an approved `story.md` into `design-doc.md`: the single source of **structure** (architecture, decisions, dependencies, and a task map). Per-task detail — the API surface each unit exposes — lives in the task files produced by `/tasks`. Neither the design doc nor the task files hold full implementations; those are written in the building phase, after inception.

## Input

The story slug, e.g. `/design-doc weather-tool`. Reads `local/user-stories/<slug>/story.md`.

## Steps

1. **Read** the story. If it still has unresolved `⏳ open:` items, STOP and recommend `/story-refine <slug>` first — a design on shifting requirements is wasted work.
2. **Read the template** in `references/design-template.md` (bundled). Match its section order.
3. **Draft the design doc.** For each section:
   - **Goal & non-goals** — lift from the story's Scope; make non-goals explicit.
   - **Architecture** — the layering/module split and *why*. An ASCII diagram + a package/file layout
     tree when it's a Python package or React/TS app. Keep each layer independently testable.
   - **Key dependencies** — a table of load-bearing choices with a one-line justification each.
     Verify versions/features against real sources; note the date verified. Do not assert versions
     from memory.
   - **Task map** — a numbered table (T1…Tn) with Task / Depends-on / File columns, plus a
     recommended order. Each task must end green (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`/tests)
     and map to a DoD checkbox in the story. This table is the contract `/tasks` expands.
   - **Cross-cutting contract** — any invariant every task must preserve (e.g. the AgentCore Runtime
     contract: ARM64, FastAPI on `0.0.0.0:8080`, `/ws` + `/invocations` + `/ping`, stateless container).
   - **Decisions & open questions** — list decided items with rationale; flag remaining ones.
4. **ADRs.** If a decision is cross-cutting and hard to reverse (e.g. CDK vs. Terraform, AgentCore Runtime vs. Gateway, stateless default), propose recording it under `docs/adr/NNNN-title.md` and reference it from the doc. Ask before creating ADR files — confirm the user wants them and the numbering.
5. **Show the draft** and confirm the architecture + task map before writing. This is the key gate: the task map drives everything downstream.
6. **On confirmation**, write `local/user-stories/<slug>/design-doc.md` and suggest `/tasks <slug>`.

## Principles

- **Structure here, API surface in tasks, implementation in the building phase.** If you're writing more than an illustrative snippet, stop — the interface belongs in a task file, the bodies belong to the build.
- Every task maps to a DoD checkbox; every DoD checkbox is covered by at least one task. Call out any gap rather than papering over it.
- Reference the story with a relative link; reference ADRs with relative links to `docs/adr/`.
