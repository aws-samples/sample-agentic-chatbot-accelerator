---
description: Run the full AI-DLC inception pipeline for a task — story → refine → design → tasks — with a human gate between each phase
user_invocable: true
---

# /ai-dlc — inception pipeline orchestrator

Walks a task through the AI-DLC **inception** phases end to end, pausing for human validation between each. A thin conductor over the per-phase skills — it does not re-implement them.

## Phases (each is a separate skill; run them in order)

1. **Story** → `story-new` — draft `story.md` from the idea.
2. **Refine** → `story-refine` — resolve open questions, verify facts, tighten scope.
3. **Design** → `design-doc` — architecture + task map (+ ADRs if warranted).
4. **Tasks** → `tasks` — expand the task map into `tasks/` (API surface per unit, not full code).

`pr-draft` is deliberately **not** part of this orchestrator: it runs *after* the building phase, once real code exists on the branch. Inception stops at the task interfaces.

**Spec-driven entry.** When the work starts from a factory spec (`specs/<name>.yaml`) rather than a rough idea, phases 1–2 are already satisfied — a spec *is* refined requirements. Enter at phase 3 via `spec-design` (spec → `design-doc.md`) instead of `design-doc`, then continue at phase 4 (`tasks`). The spec, not a `story.md`, is the source of truth; re-run `spec-design` when the spec changes.

## Input

An idea and optional slug, e.g. `/ai-dlc weather-tool "MCP tool that fetches current weather"`. If resuming an existing story, pass just the slug and this skill picks up at the first incomplete phase.

## How to run

1. **Determine the starting phase.** First, if a `specs/<slug>.yaml` exists (spec-driven work), enter at phase 3 via `spec-design` and skip phases 1–2 entirely. Otherwise check `local/user-stories/<slug>/` for existing artifacts:
   - no folder / no `story.md` → start at phase 1.
   - `story.md` present but has `⏳ open:` items → start at phase 2.
   - refined `story.md`, no `design-doc.md` → phase 3.
   - `design-doc.md` present, no `tasks/` → phase 4.
   State which phase you're starting at and why.
2. **Run each phase by invoking its skill** (the Skill tool), in order, passing the slug.
3. **Gate between phases.** After a phase produces its artifact and the user approves it, ask the user to confirm before advancing to the next phase. If the user wants to stop after any phase, stop — each artifact stands on its own and the pipeline is resumable later.
4. **Never skip a gate or auto-advance past an unapproved artifact.** The value of AI-DLC here is the human validation between steps; preserve it. A phase's output must be approved before the next phase consumes it.
5. **After phase 4**, tell the user inception is complete and the tasks are ready for the building phase; `/pr-draft <slug>` comes later, after code is written.

## Principles

- Thin orchestration only — defer all phase logic to the per-phase skills so behavior stays consistent whether a phase is run standalone or via `/ai-dlc`.
- Resumable and re-runnable: any phase can be re-invoked to revise its artifact without redoing the others.
