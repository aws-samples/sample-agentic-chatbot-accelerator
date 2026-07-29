---
description: Expand a design doc's task map into a tasks/ folder — a README index plus one file per subtask
user_invocable: true
---

# /tasks — decompose into subtasks

Step 4 of the AI-DLC pipeline. Expands the **Task map** from an approved `design-doc.md` into a `tasks/` folder: a `README.md` index and one `T<N>-<slug>.md` file per task. Task files specify the **API surface** (interface + docs) for each unit — not full implementations. Writing the implementation is the building phase's job, which starts after inception is complete.

## Input

The story slug, e.g. `/tasks weather-tool`. Reads `local/user-stories/<slug>/design-doc.md`.

## Steps

1. **Read** the design doc, especially its Task map table (# / Task / Depends on / File) and the cross-cutting contract. If there is no task map, STOP and recommend `/design-doc <slug>` first.
2. **Read the templates** in `references/` (bundled): `tasks-readme-template.md` and `task-template.md`.
3. **Generate the index** `tasks/README.md` from the design doc's task map: a status table (#, Task, Status, Depends on) with every task starting at `not-started`, the recommended order, and the status-progression note.
4. **Generate one file per task**, `tasks/T<N>-<slug>.md`, each with: a metadata table (Status / Depends-on) followed by a **Satisfies (story Definition of Done)** bullet list (one verbatim-quoted DoD checkbox per bullet), then Objective, Files, an **API surface** for that unit, Notes/gotchas, an Acceptance checkbox list, and any task-local Decisions.
   - **API surface, not implementation.** Specify the *interface* the building phase will implement: public function signatures, classes, Pydantic/dataclass models, enums, protocols (TS: functions, interfaces, types), key type signatures — each with a docstring describing intent, invariants, and error conditions. Leave bodies as `...` / `raise NotImplementedError` / `throw new Error("todo")` / prose. The goal is to give the building-phase agent clear guidance on **what** to build without handing it a **how** to copy-paste. Do NOT write full implementations here — that is the building phase's job, which runs after inception is complete.
   - Where an exact SDK API shape is uncertain, include the intended signature and add a "confirm at build/type-check time" note pointing at the relevant docs/example.
5. **Keep task files consistent with the design doc** — same file paths, same dependency edges, same DoD mapping. Every DoD checkbox in the story should be covered by at least one task's Acceptance; flag any gap.
6. **Show the proposed file list + the README index** and confirm before writing all files.
7. **On confirmation**, write `tasks/README.md` and each `tasks/T*.md`. Tell the user the tasks are ready to build, and that status should progress `not-started → in-progress → done` (in both the README table and each file's `**Status:**`) as work proceeds.

## Principles

- One task = one coherent unit that, once *implemented*, ends green (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`/tests). If a task can't be verified in isolation, it's too big or wrongly cut — revisit the split.
- Inception stops at the interface. If you're tempted to write function bodies, stop — that's the building phase.
- Don't re-derive architecture here; if the decomposition reveals a structural problem, surface it and suggest editing the design doc rather than silently diverging.
- Task code must honor the design doc's cross-cutting contract (e.g. ARM64, FastAPI on `0.0.0.0:8080`, stateless container).
