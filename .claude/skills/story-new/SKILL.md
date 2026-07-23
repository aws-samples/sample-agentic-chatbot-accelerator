---
description: Draft a new AI-DLC user story from a one-line idea into local/user-stories/<name>/story.md
user_invocable: true
---

# /story-new — draft a user story

Kicks off the AI-DLC pipeline (inception phase) by turning a rough idea into a structured `story.md`. This is step 1 of: **story-new → story-refine → design-doc → tasks → (build) → pr-draft**.

## Input

The user's argument is a short idea and (ideally) a slug for the folder, e.g. `/story-new weather-tool "an MCP tool that fetches current weather for a city"`.

If no slug is given, propose one (kebab-case, derived from the idea) and confirm it.

## Steps

1. **Resolve the target folder.** `local/user-stories/<slug>/`. If it already exists and contains a `story.md`, STOP and ask whether to overwrite or pick a new slug — never clobber silently.
2. **Read the template** in `references/story-template.md` (bundled in this skill folder). It is the canonical shape. Match its section order and conventions.
3. **Draft the story.** Fill the template from the idea. It is fine — expected — to leave `Investigation outcomes` sparse and mark unknowns explicitly as `⏳ open:` items; `/story-refine` resolves those next. Do NOT invent library versions, API shapes, or AWS contract details you haven't verified — flag them as open questions instead.
4. **Show the draft to the user** (the full proposed `story.md`) and ask for approval or edits. Do not write the file until the user confirms.
5. **On confirmation**, write `local/user-stories/<slug>/story.md` and tell the user the path plus the suggested next step: `/story-refine <slug>`.

## Conventions

- Stories live under `local/user-stories/<slug>/` — this is gitignored working space, by design.
- Keep it a *story*, not a design: describe **what** and **why**, defer **how** to the design doc.
- The `Definition of Done` is a checkbox list of observable, testable outcomes.
