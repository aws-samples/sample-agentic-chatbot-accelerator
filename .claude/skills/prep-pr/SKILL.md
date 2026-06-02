---
name: prep-pr
description: Prepare a development branch for a pull request to main. Run /code-review and ASH security scan, auto-fix high-confidence issues, then draft a PR title and body. Use this whenever the user signals intent to open a PR ("create a PR", "open a PR", "ready to PR", "submit PR", "PR this branch", "let's PR this"), even if they don't mention code review or security scans explicitly — running both gates is the whole point of the skill.
user_invocable: true
---

# prep-pr

Gate a branch on quality + security checks, then hand the user a clean PR write-up they can paste into GitHub.

The skill has three phases. Run them **in order** — fixing review findings first means the ASH scan (slower) only runs once on already-clean code, and writing the PR message last means it can describe the final state of the branch rather than the messy intermediate one.

## Phase 0 — Orient

Before running any checks, get a clear picture of what the PR will contain. Skipping this leads to PR descriptions that miss commits or describe code that was already merged.

1. `git status` — confirm working tree is clean. If there are uncommitted changes, ask the user whether to commit, stash, or include them before proceeding. Don't silently include uncommitted work in the analysis.
2. `git rev-parse --abbrev-ref HEAD` — confirm we're not on `main`. If we are, stop and ask which branch to prep.
3. `git fetch origin main` then `git log --oneline origin/main..HEAD` — list the commits that will land. This is the source of truth for the PR description; don't rely on memory of the conversation.
4. `git diff origin/main...HEAD --stat` — see the shape of the change (files touched, line counts). Useful for both the review phase (where to focus) and the PR body (scope summary).

Tell the user what you see in one or two sentences ("Branch `foo` has 4 commits ahead of main, touching 7 files in `iac-cdk/` and `src/agent-core/`. Starting code review.") so they can correct the scope before you spend tokens on scans.

## Phase 1 — Code review

Invoke the `/code-review` skill at **medium** effort by default. It reviews the current diff for correctness bugs and reuse/simplification cleanups. Higher effort modes surface more findings but also more noise — medium is the sweet spot for pre-PR.

Apply fixes with this policy:

- **Auto-apply** clear-cut findings: typos, unused imports/variables, obvious null checks, dead code, simple refactors the reviewer flagged with high confidence.
- **Surface for confirmation** anything that changes behavior, touches a public interface, or that the reviewer flagged as "uncertain" / "possible". Show the user the finding, the proposed fix, and ask before changing.
- **Defer** findings that are out of scope for this PR (pre-existing issues in untouched code, larger refactors). Note them in a "Follow-ups" list — they go in the PR body so they're not lost.

After applying fixes:

- Re-run `git diff origin/main...HEAD --stat` to confirm the diff still looks reasonable (no accidental large-scale rewrites from a fix that snowballed).
- If you applied non-trivial fixes, **commit them as a separate commit** with a clear message (e.g. `fix: address code review findings`) rather than amending. This preserves the review trail and makes it easy to revert one batch of fixes if something goes sideways.
- Do **not** re-run `/code-review` in a tight loop hoping for zero findings. One pass + targeted fixes is the goal; a second pass is only worth it if the first pass caused you to make substantial changes.

## Phase 2 — Security scan (ASH)

Run `make run-ash` from the repo root. ASH bundles checkov, npm-audit, bandit, detect-secrets, cdk-nag, and semgrep — `CONTRIBUTING.md` requires it before any PR.

ASH is slow (several minutes). Tell the user it's running in the background and what you'll do while waiting (e.g. drafting the PR body skeleton from the commit log). Don't sit idle.

Triage findings by severity:

- **Critical / High**: must be fixed before the PR opens. These block.
  - Real vulnerabilities (hardcoded secrets, SQL injection, overly permissive IAM, public S3 buckets without justification): fix.
  - False positives in this codebase's context (e.g. cdk-nag flagging a logging bucket that intentionally has no access logs): suppress with the appropriate inline mechanism (`NagSuppressions.addResourceSuppressions`, `# nosec`, etc.) **with a one-line justification comment**. Never suppress without explaining why — silent suppressions rot.
- **Medium / Low**: surface them in the PR body under a "Known scan findings (non-blocking)" section so reviewers see them. Don't auto-fix unless trivial.
- **Informational**: ignore unless the user asks.

Re-run `make run-ash` after fixes to confirm the critical/high count is zero. Commit fixes as `fix(security): address ASH findings` (or similar), separate from the review-fix commit.

## Phase 3 — Draft the PR message

Output a draft the user can paste into GitHub. Do **not** create the PR yourself — the user wants to review and create it manually.

### Title

- Under 70 characters. Imperative mood. No trailing period.
- Match the repo's commit style — recent commits use gitmoji prefixes (🚑, ♻️, 🐛, ⬆️). Match that, or fall back to a plain conventional-commits prefix (`feat:`, `fix:`, `refactor:`) if the change doesn't fit a single emoji.
- Lead with the **what**, not the why. The body explains why.

**Bad:** `Some fixes and improvements to the deploy script`
**Good:** `🚑 fix race condition in parallel CodeBuild trigger`

### Body

Use this template:

```markdown
## Summary

<2–4 sentences: what changed and why. Reviewer-first — they want to know
the motivation and the shape of the change before reading the diff.>

## Changes

- <bulleted list of meaningful changes, grouped by area if the PR spans
  multiple areas — e.g. "**CDK:** ...", "**Agent container:** ...">
- <skip mechanical changes (lint, formatting) unless they're the whole PR>

## Test plan

- [ ] <how you verified this works — e.g. "Deployed to sandbox account,
  ran `make deploy`, confirmed AcaStack synthesizes without nag errors">
- [ ] <UI/UX changes: include a screenshot or describe what was clicked>
- [ ] <regression check if relevant>

## Known scan findings (non-blocking)

<only include this section if Phase 2 surfaced medium/low findings the
user accepted. Otherwise omit the section entirely.>

## Follow-ups

<only include if Phase 1 deferred any findings. Otherwise omit.>
```

### Good practices to apply when drafting

- **Lead with motivation.** "We were getting X, now we get Y" beats "Refactored Z." Reviewers calibrate scrutiny based on why.
- **Mention what you did NOT do** when scope was tempting. e.g. "Did not migrate the Terraform side — tracked separately." Prevents reviewer scope-creep questions.
- **Call out anything risky or surprising explicitly** — destructive migrations, perf-sensitive paths, behavior changes in shared utilities. The PR body is the right place to surface concerns proactively, not bury them.
- **Reference issues / Taskei / SIM tickets** if the user mentioned any during the conversation.
- **No marketing voice.** Skip "comprehensively", "robust", "seamlessly". Plain, factual.
- **Test plan is checkboxes the reviewer can verify**, not a brag list. If you can't test it locally, say so explicitly ("Cannot test the AppSync subscription locally — verified by reading the schema diff and the resolver wiring") rather than claiming success.

After drafting, present the title + body in a fenced block and tell the user how to use it: "Copy this into `gh pr create --title '...' --body '...'` or paste into the GitHub UI." Don't auto-push or auto-create.

## Notes on running checks

- `/code-review` and `make run-ash` both produce a lot of output. Don't dump it all into the conversation — summarize by severity and surface the actual findings.
- If either check fails to run (missing tooling, permission error), say so explicitly and ask the user how to proceed. Do not silently skip a phase and pretend the gate passed.
- Token cost matters: a typical run of this skill on a moderate PR is a few minutes of wall time and a meaningful chunk of tokens. If the diff is tiny (one-line fix), tell the user and ask whether they want the full pipeline or just the PR draft.
