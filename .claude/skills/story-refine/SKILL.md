---
description: Clarify and harden an existing draft story.md — resolve open questions and challenge assumptions before design
user_invocable: true
---

# /story-refine — clarify a story

Step 2 of the AI-DLC pipeline. Takes a draft `story.md` and makes it design-ready: resolves open questions, verifies external facts, challenges hidden assumptions, and tightens the Definition of Done. Output is the *same* `story.md`, improved in place.

## Input

The user's argument is the story slug (folder under `local/user-stories/`), e.g. `/story-refine weather-tool`. If omitted and only one in-progress story exists, use it; otherwise list the candidates and ask.

## Steps

1. **Read** `local/user-stories/<slug>/story.md`.
2. **Interrogate it.** Produce a short list of the things that must be resolved before a design doc can be written. Draw from:
   - `⏳ open:` items already flagged in the story.
   - **Unstated assumptions** — transport, statefulness, auth boundary, error semantics, number/data types, dependency choices, target platform (recall: AgentCore requires ARM64).
   - **Unverified external facts** — library names/versions, SDK API shapes, AWS contract details. Verify these against real sources (PyPI, npm, official docs) rather than asserting from memory. Use WebFetch / the aws docs tools where available; if you cannot verify, say so and keep it an open question rather than guessing.
   - **Scope creep / ambiguity** — anything in the description that could be read two ways.
3. **Ask the user the open questions** in a batch (use the question prompt UI). Recommend a default for each where you have a defensible one, so the user can accept quickly. Do not proceed on assumptions the user hasn't confirmed.
4. **Fold the answers back in:** move resolved items into `Investigation outcomes`, tighten `Scope`, sharpen the `Definition of Done`, and delete the open-questions block once empty. Flag any decision that looks ADR-worthy (a cross-cutting, hard-to-reverse choice) so `/design-doc` can record it.
5. **Show a diff/summary** of what changed and confirm before writing.
6. **On confirmation**, write the updated `story.md` and suggest the next step: `/design-doc <slug>`.

## Principles

- Refining means *reducing uncertainty*, not adding implementation detail — leave the **how** to the design doc. If you find yourself writing code or file layouts, that belongs in `/design-doc`.
- Prefer resolving a question to deferring it, but an honestly-deferred question (with rationale) is better than a guessed answer.
- Keep the story's proven section shape (see the `story-new` skill's `references/story-template.md`).
