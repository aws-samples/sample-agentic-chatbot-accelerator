# Trace-driven diagnosis

Diagnose a misbehaving agent from its traces and propose **config** changes that address
the root cause, then re-submit via the modify path. This is a smarter front-end on the
modify path — the only new work is the diagnosis (observed behavior → config knob);
everything after is read-modify-write verbatim.

## What can — and can't — be fixed here

You edit *config*, so you fix issues whose root cause **is** config. Be honest with the
user about that boundary.

| Symptom in the traces | Config fix |
|---|---|
| Ambiguous / under-specified behavior; agent does the wrong thing vaguely | edit `instructions` (sharpen the system prompt) |
| Wrong tool chosen, or a tool it has is never used | tighten the prompt about when to use which; add or remove a tool |
| Missing capability the task needs | add a tool / MCP / skill — **if it's in the registry**; else custom-code (redeploy, task 07) |
| Truncated / too-terse output, or no/!reasoning | edit `modelInferenceParameters` — raise `maxTokens`, change `modelId`, set `reasoningBudget` |
| Context lost over long sessions | switch `conversationManager` (`sliding_window` → `summarizing`) |
| Single agent overwhelmed by a multi-step job | recommend SWARM / GRAPH — a **rebuild** (new architecture), not an edit |
| **Bug inside a tool's implementation** (tool errors, wrong results from correct args) | ❌ **out of scope** — that's code, not config. Flag it, point at custom-code; do **not** pretend a config edit fixes it |

State the framing to the user: *"hand me traces; I'll diagnose and propose config changes
for config-level causes — not bugs inside a tool's code."*

## Trace tiers & the AWS-profile boundary

Diagnostic richness is bounded by which trace you can reach, and the sources split on
whether they need an AWS profile. `scripts/fetch_traces.py` implements tiers 1–2; tier 0
needs no script.

| Tier | Source | Reached via | AWS profile? | What you get |
|---|---|---|---|---|
| **0** | User pastes a trace / transcript / eval reason | nothing (provided text) | **No** | whatever they paste |
| **1** | Session history — `--session <id>` (`getSession`) | GraphQL (Cognito JWT) | **No** | conversation text, citations, reasoning, **tool-action summaries** (not raw args/results), feedback, per-turn latency, completeness |
| **1** | Eval summaries — `--evaluator <id>` (`getEvaluator`) | GraphQL (Cognito JWT) | **No** | per-case input / expected / actual / score / **`reason`** / latency, pass/fail |
| **2** | Full eval **trajectory** — `--evaluator <id> --deep` (`resultsS3Path`) | S3 GetObject | **Yes** | model calls, tool selection + args + results, latencies |
| **2** | Span logs — `--xray --session-id <s>` (`aws/spans`) | CloudWatch Logs | **Yes** | distributed spans, latency, token usage, errors |

**Default is profile-free (tiers 0–1)** — same Cognito JWT the rest of the plugin uses.
**Tier 2 is an explicit opt-in** needing `PROFILE=…` (+ `REGION`) with read perms
(`s3:GetObject` on the evaluations bucket; `logs:FilterLogEvents` on the span group).

### Graceful degradation (don't crash without a profile)

If the user asks for a deep diagnosis and there's no usable profile, `fetch_traces.py`
exits with a clear message — **not** a credentials traceback. Relay it and offer the
profile-free alternative: *"paste the session transcript, or point me at the evaluator
(`--evaluator <id>` without `--deep`) — I can diagnose from the tier-1 summaries."* Only
push for tier 2 when the tier-1 signal genuinely can't explain the issue (e.g. you need
the exact tool args, or latency/error spans).

## How to diagnose from each tier

- **Tier 0/1 session** (`fetch_traces.py --session`): read `issues_observed` (negative
  feedback, tool-action summaries, incomplete responses) and the full `raw.history`. Look
  for: the agent ignoring available tools, vague answers (prompt), dropped earlier context
  (conversation manager), truncated endings (`maxTokens`).
- **Tier 1 evaluator** (`--evaluator`): each failed case's **`reason`** (the grader's
  explanation) plus expected-vs-actual is the richest config signal — it often names the
  gap directly ("did not cite sources", "ignored the constraint"). Map `reason` → the
  prompt/tool/model knob.
- **Tier 2 deep / xray**: use only when you need tool args/results or latency/error detail
  the summaries lack. Read `trajectory` (S3) or span `events` from `raw`.

## After diagnosis — the modify path

Diagnosis done, the rest is the modify path (see SKILL.md / update-semantics.md):

1. `fetch_agent_config.py --agent XYZ` → full current config.
2. Apply targeted edits to the **full** config (never a patch). Show before/after; for
   each edit, name the observed issue it addresses and your confidence.
3. `validate_config.py` (with building-blocks) → `submit_runtime.py` → poll Ready.
4. **The fix is live but UNVERIFIED.** Tell the user so, and give a concrete check:
   re-run the failing eval cases, or manually reproduce the trace scenario in the UI.
   Behavioral verification (re-run cases, confirm the score rose) is out of scope for now
   — the evaluations feature is its natural engine.
