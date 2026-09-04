# Design Doc — <Story title>

> Companion to [`story.md`](story.md). **High-level** design: requirements, architecture, failure handling, and the task map. Detailed code for each unit of work lives in [`tasks/`](tasks/) — this doc is the single source of *structure*, the task files are the single source of *code*.
>
> <Optional: note the SDK/library versions this was verified against and the date.>

## 1. Goal & non-goals

**Goal:** <one sentence — the deliverable, in terms of observable behaviour.>

**Non-goals (this story):** <explicitly deferred work, each with a short clause on *why it is deferred rather than dropped*. Link ADRs where a non-goal is a recorded decision.>

## 2. Requirements

<Numbered so later sections can cite them (`FR3`, and the contract rows in §5) and so `/tasks` can trace coverage. Every requirement must be *checkable* — if you can't say how you'd know it holds, it's a wish, not a requirement. Derive each from the story: the `Source` column cites the DoD checkbox or Scope clause it comes from.>

| # | Requirement | Source |
|---|---|---|
| FR1 | <what the system does, observable from outside> | <story DoD line / Scope clause> |
| FR2 | <…> | |

<Non-functional constraints do **not** get their own table — they are rows in §5 (Contract to preserve) with a target and a `Verified by`. One table, not three.>

## 3. Architecture

<Prose + an ASCII diagram of the layers/modules and their responsibilities. One line per layer on why it's separated. Annotate which requirement each part serves (`→ FR2`). Anchor claims about existing behaviour with `file:line`.>

```
┌───────────────────────────────┐
│ <layer>   <responsibility>     │
├───────────────────────────────┤
│ <layer>   <responsibility>     │
└───────────────────────────────┘
```

**File layout:** <a tree of the files to be created/changed, annotated with the task that produces each. Mirror the repo's `src/<feature>/` ↔ `iac-cdk/lib/<feature>/` convention where relevant. This tree is what the building-phase agent navigates by — keep it.>

```
src/<feature>/<name>/
├── __init__.py      # T?   (Python) — or index.ts for a TS module
├── handler.py       # T?
└── tests/
    └── test_*.py    # T?
```

**Alternatives considered:** <one line each for the shapes you rejected and the reason — especially the obvious approach, if you are not taking it. Skip only if there genuinely were none.>

## 4. Key dependencies

<Table of load-bearing choices only — not every transitive dep. When the answer is "no new dependencies", say so and still list what existing pieces the design leans on.>

| Dependency | Why |
|------------|-----|
| `<package>` (extras …) | <one-line justification> |

> <Version pinning policy / verification date, if relevant.>

## 5. Contract to preserve

<Invariants every task must hold, including the non-functional constraints from §2's preamble. Cover the standing ones where they apply (e.g. AgentCore Runtime: ARM64, FastAPI on `0.0.0.0:8080`, `/ws` + `/invocations` + `/ping`, stateless container) *and* the ones this change introduces.>

| Invariant | Target / bound | Why | Enforced in | Verified by |
|---|---|---|---|---|
| <e.g. backward compatibility> | <e.g. existing deploys upgrade with no resource replacement> | <what breaks otherwise> | T? | <test / assertion / manual check> |

## 6. Edge cases & failure handling

**Mandatory.** The section that earns the doc: each row is a concrete condition, the chosen behaviour, and why that behaviour and not the alternative. Include the cases you decided to **accept** rather than handle — an accepted limitation, written down, is a design output.

If there genuinely are none beyond §5, write "none beyond the contract rows above, because <reason>" — that is a valid answer. Fabricating rows to fill the table is not.

| Condition | Behaviour | Rationale |
|---|---|---|
| <e.g. config file present but corrupt> | <e.g. treat as absent, log, continue> | <e.g. a stale file must never be fatal> |
| <e.g. no TTY and input still incomplete> | <e.g. error listing every missing field> | <CI must fail, not block> |
| <e.g. two concurrent runs> | <accepted: last write wins> | <cost of locking exceeds the harm> |

## 7. Key flows (optional)

<For each path where the *ordering* or the *failure sequencing* is the point, the ordered steps including where it can fail. Include only such flows — a walkthrough of the happy path adds nothing to §3.>

## 8. Task map

Each task ends green (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`/tests; Rust: `cargo fmt`/`clippy -D warnings`/`test`) and maps to a Definition-of-Done checkbox in the story. Detail + code go in each task file. This table is the contract `/tasks` expands.

| # | Task | Requirements | Depends on | File |
|---|------|--------------|-----------|------|
| T1 | <scaffold> | FR1 | — | [tasks/T1-*.md](tasks/T1-*.md) |
| T2 | <...> | FR2, FR3 | T1 | [tasks/T2-*.md](tasks/T2-*.md) |

Recommended order: <T1 → T2 → …, noting which can run in parallel>.

**Coverage:** <one line mapping every story DoD checkbox to the task(s) that discharge it, and noting any FR or §6 row that no task owns.>

## 9. Decisions & open questions

**Decided:**

1. ✅ **<decision>:** <what and why.> → T?, → FR?

**Still open:**

- ⏳ **<question>:** <what's undecided, who decides, and when.> → T?

---

<!--
Notes for the author (delete before shipping):

- §2 is the contract; §6 is where a design doc stops being a summary of the story.
  A design that has no §6 rows on a change touching live infrastructure, persisted
  state, or an interactive surface has not been thought through yet.
- Structure and rationale live here; the API surface of each unit lives in tasks/;
  bodies are written in the building phase. If you are writing function bodies, stop.
- Anchor every claim about existing behaviour with `file:line`. This doc is re-read at
  every build step, and a path with a line number is the highest-value token in it.
- No section filled to be filled. An invented requirement, or a section that restates
  the story in other words, is worse than a shorter doc. Target ≤ 250 lines.
- Verify external facts (versions, API shapes, service limits) against a real source
  and note the date. Do not assert versions from memory.
-->
