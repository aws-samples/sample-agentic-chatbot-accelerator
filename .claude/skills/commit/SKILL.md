---
description: Generate a commit message and description for staged/unstaged changes
user_invocable: true
---

1. Run `git status` and `git diff` to understand what changed.
2. Run `git log --oneline -5` to match the repository's existing commit style.
3. Draft a commit message following the **gitmoji** specification for the subject line, with Conventional-Commits-style body and footers (see `REFERENCE.md` for the full cheatsheet):
   - **Subject**: `<emoji> [scope?][:?] <message>` — pick a single emoji that captures the *intent* of the change (`🐛` fix, `✨` feature, `♻️` refactor, `⚡️` perf, `📝` docs, `🚑` hotfix, `⬆️` deps, etc.). Keep the message imperative mood, under ~72 chars total. Use the unicode emoji, not the `:shortcode:` form — it matches the existing `git log` in this repo and renders everywhere.
   - **Scope** (optional): in parentheses after the emoji, e.g. `♻️ (components): transform classes to hooks`. Use when it disambiguates which area changed.
   - **Body** (if needed): blank line, then 1-3 sentences explaining context or motivation — *why*, not what. Gitmoji is silent on bodies, so we follow Conventional Commits here.
   - **Breaking changes**: add a `BREAKING CHANGE: <description>` footer (Conventional Commits convention). Gitmoji has no native breaking-change marker — the footer is what downstream tooling looks for.
   - **Issue/ticket refs**: footer lines like `Refs: SIM-1234` or `Closes #42`.
4. Present the message to the user for approval before committing.
5. Only commit after the user confirms.
