# <Title — one line, "As <role>, I want <capability>, so that <benefit>">

## Description

<2–5 sentences: what the feature/tool/change does, where it lives (e.g. a Python package under `src/<feature>/`, a construct under `iac-cdk/lib/<feature>/`, or a React component under `src/user-interface/`), and the essential contract. Include a small contract table when a tool has a typed input/output, e.g.:>

| Field | Type | Notes |
|-------|------|-------|
| `operation` | string enum | `add` \| `subtract` \| ... |
| `a` | number | first operand |
| result | `{ "result": number }` | error conditions noted |

<Optional: an illustrative code sketch. If shown, label it clearly as illustrative — the real implementation may replace it (e.g. with a framework decorator or SDK helper). Do not present a sketch as the final shape.>

## Investigation outcomes (resolved)

<Numbered subsections, one per decided question. Each states the decision, a one-line rationale, and a source link where external facts are involved. Leave sparse in a fresh draft — /story-refine fills these in. Mark anything unverified as an open question below instead of guessing.>

### 1. <Decision area — e.g. Library choice>

- <what was decided and why, with a source link if it's an external fact>

## Scope

**In scope:** <the observable deliverables of this story.>
**Out of scope (follow-up):** <explicitly deferred work — deployment, auth, extra features, etc.>

## Definition of Done

<Checkbox list of observable, testable outcomes. Each should map to something a reviewer can verify.>

- [ ] <e.g. a package exists under `src/<feature>/` and `ruff`/`black`/`pytest` pass (or, for TS, `tsc`/`eslint`/tests pass)>
- [ ] <e.g. the tool can be listed and invoked, including the documented error path>
- [ ] <...>

---

<!-- Open questions for /story-refine to resolve. Delete this block once none remain. -->
<!-- ⏳ open: <question that needs an answer before design> -->
