# Design Doc — <Story title>

> Companion to [`story.md`](story.md). **High-level** design: architecture, decisions, and the task map. Detailed code for each unit of work lives in [`tasks/`](tasks/) — this doc is the single source of *structure*, the task files are the single source of *code*.
>
> <Optional: note the SDK/library version this was verified against and the date.>

## 1. Goal & non-goals

**Goal:** <one sentence — the deliverable.>

**Non-goals (this story):** <explicitly deferred work.> <Link ADRs where a non-goal is a recorded decision.>

## 2. Architecture

<Prose + an ASCII diagram of the layers/modules and their responsibilities. One line per layer on why it's separated.>

```
┌───────────────────────────────┐
│ <layer>   <responsibility>     │
├───────────────────────────────┤
│ <layer>   <responsibility>     │
└───────────────────────────────┘
```

**File layout:** <a tree of the files to be created/changed, annotated with the task that produces each. Mirror the repo's `src/<feature>/` ↔ `iac-cdk/lib/<feature>/` convention where relevant.>

```
src/<feature>/<name>/
├── __init__.py      # T?   (Python) — or index.ts for a TS module
├── handler.py       # T?
└── tests/
    └── test_*.py    # T?
```

## 3. Key dependencies

<Table of load-bearing choices only — not every transitive dep.>

| Dependency | Why |
|------------|-----|
| `<package>` (extras …) | <one-line justification> |

> <Version pinning policy / verification date, if relevant.>

## 4. Task map

Each task ends green (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`/tests) and maps to a Definition-of-Done checkbox in the story. Detail + code go in each task file.

| # | Task | Depends on | File |
|---|------|-----------|------|
| T1 | <scaffold> | — | [tasks/T1-*.md](tasks/T1-*.md) |
| T2 | <...> | T1 | [tasks/T2-*.md](tasks/T2-*.md) |

Recommended order: <T1 → T2 → …, noting which can run in parallel>.

## 5. <Cross-cutting contract> (optional)

<Any invariant every task must preserve. For AgentCore Runtime containers, restate the contract and which task enforces each row.>

| Requirement | Value | Enforced in |
|-------------|-------|-------------|
| Platform | ARM64 / aarch64 | T? |
| Host / Port | `0.0.0.0` / `8080` (A2A twin: `9000`) | T? |
| Routes | FastAPI `/ws`, `/invocations`, `/ping` | T? |
| Session model | stateless container; history in DynamoDB | T? |
| Auth | none in container (runtime is boundary) | all |

## 6. Decisions & open questions

**Decided:**

1. ✅ **<decision>:** <what and why.> → T?

**Still open:**

- ⏳ **<question>:** <what's undecided and when it'll be decided.> → T?
