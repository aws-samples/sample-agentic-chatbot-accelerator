---
description: Generate a high-level design doc (requirements, architecture, failure handling) + task map from an approved story.md
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
   - **Goal & non-goals** — lift from the story's Scope; make non-goals explicit, each with a clause on
     why it is deferred rather than dropped.
   - **Requirements** — number every functional requirement `FR1…FRn` with the story DoD line or Scope
     clause it derives from. Each must be *checkable*. Non-functional constraints do **not** get their own
     table: they become rows in the Contract to preserve, with a target and a `Verified by`. Only the
     constraints this design is actually bound by — an aspirational list is noise.
   - **Architecture** — the layering/module split and *why*. An ASCII diagram + the annotated file-layout
     tree (per-file task attribution). Keep each layer independently testable. Close with
     **Alternatives considered** — one line each, especially for the obvious approach you are not taking.
   - **Key dependencies** — a table of load-bearing choices with a one-line justification each.
     Verify versions/features against real sources; note the date verified. Do not assert versions
     from memory. "No new dependencies" is an answer — say it, and still name what the design leans on.
   - **Contract to preserve** — invariants every task must hold, including the non-functional ones
     (e.g. the AgentCore Runtime contract: ARM64, FastAPI on `0.0.0.0:8080`, `/ws` + `/invocations` +
     `/ping`, stateless container). One table with `Enforced in` and `Verified by`, not three overlapping ones.
   - **Edge cases & failure handling** — mandatory. Each row is a concrete condition, the chosen
     behaviour, and why that behaviour and not the alternative. Include cases you decided to **accept**;
     an accepted limitation, written down, is a design output. "None beyond the contract rows, because …"
     is valid; fabricating rows to fill the table is not.
   - **Key flows** — optional, and only where the ordering or the failure sequencing is the point.
   - **Task map** — a numbered table (T1…Tn) with Task / Requirements / Depends-on / File columns, plus a
     recommended order. Each task must end green (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`/tests;
     Rust: `cargo fmt`/`clippy -D warnings`/`test`) and map to a DoD checkbox in the story. Every FR must
     appear against at least one task. This table is the contract `/tasks` expands.
   - **Decisions & open questions** — list decided items with rationale, citing the task and the
     requirement each serves; flag remaining ones.
4. **Adversarial pass — before showing the draft.** For each item below, either write an edge-case row or
   state explicitly that it does not apply. This checklist, not the section headings, is what actually
   finds defects at design time:
   1. the config key / input absent, blank, or malformed;
   2. **upgrading an existing deployment** — including IaC resource-address changes (a Terraform module
      gaining `count` re-addresses everything inside it; a changed CloudFormation logical id replaces the
      resource);
   3. the reverse direction — the feature turned off and then back on;
   4. no TTY / CI / piped stdin / non-interactive invocation;
   5. persisted state corrupt, partial, or stale;
   6. **file mode and ownership after a writer you don't control** (an external editor, another process);
   7. concurrency, and whether last-write-wins is acceptable;
   8. interaction with each *other* independently-gated optional feature;
   9. what an operator loses from the outputs, and what replaces it.

   Do not fabricate a row to fill a slot — "N/A because …" is a valid answer and is cheaper to review.
5. **ADRs.** If a decision is cross-cutting and hard to reverse (e.g. CDK vs. Terraform, AgentCore Runtime vs. Gateway, stateless default), propose recording it under `docs/adr/NNNN-title.md` and reference it from the doc. Ask before creating ADR files — confirm the user wants them and the numbering.
6. **Show the draft** and confirm the requirements, architecture, and task map before writing. This is the key gate: the task map drives everything downstream.
7. **On confirmation**, write `local/user-stories/<slug>/design-doc.md` and suggest `/tasks <slug>`.

## Principles

- **Structure here, API surface in tasks, implementation in the building phase.** If you're writing more than an illustrative snippet, stop — the interface belongs in a task file, the bodies belong to the build.
- Every task maps to a DoD checkbox; every DoD checkbox is covered by at least one task. Call out any gap rather than papering over it.
- **Anchor every claim about existing behaviour with `file:line`.** The task files and the building-phase agent re-read this doc; a path with a line number is the highest-value token in it. A doc that describes a coupling without citing where it lives has moved the work downstream, not done it.
- **No section filled to be filled.** An empty row, an invented requirement, or a section that restates the story in other words is worse than a shorter doc. Write "none" and move on. Target ≤ 250 lines.
- Reference the story with a relative link; reference ADRs with relative links to `docs/adr/`.
