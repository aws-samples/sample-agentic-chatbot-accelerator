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
5. `git diff --name-only origin/main...HEAD` — capture the **PR file list**. You'll use this in Phase 2 to gate on diff-touched findings only. Save it; don't recompute later.

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

**Scope: scan whole repo, gate on diff.** ASH must scan the whole project — cdk-nag and checkov scan synthesized CFN templates, not your `.ts`/`.py` sources, and a one-line edit can change the whole template. There is no correct way to scope ASH to "just my files." What we *can* do is partition findings into PR-touched (block) vs. pre-existing (surface, don't block) — that gives you a useful gate without lying about scope.

### Skip-fast check

Before running, look at the PR file list from Phase 0. If **none** of the changed files are in scanner scope, skip ASH entirely and tell the user why. Out-of-scope: `*.md`, `CLAUDE.md`, `.claude/**`, `.gitignore`, `.editorconfig`, image/binary assets, lockfile-only changes (`package-lock.json` alone). In-scope: any `.py`, `.ts`, `.tsx`, `.js`, `.tf`, `.yaml`/`.yml` under `iac-*/`, `Dockerfile*`, `iac-cdk/bin/config.*`, `.pre-commit-config.yaml`, `.ash/.ash.yaml`. When in doubt, run.

### Run — two tiers

ASH (the full bundle) takes 10–15 minutes. Don't make that the first thing you wait on. Use a two-tier approach: fast scoped scanners on the PR diff first, then full ASH in the background while drafting the PR body. You catch obvious issues in seconds; the full scan still runs as the source-of-truth gate before you finish.

**Tier 1 — scoped scanners on the diff (~30s, run in the foreground).**

Get the changed files from Phase 0's PR file list. Group by file type and run only the relevant scanners:

```bash
# Python files in the diff
PR_PY=$(git diff --name-only origin/main...HEAD -- '*.py' | grep -v 'iac-terraform/build/\|cdk.out/asset')
[ -n "$PR_PY" ] && bandit -ll $PR_PY

# Terraform files in the diff — scope to changed modules only
PR_TF_DIRS=$(git diff --name-only origin/main...HEAD -- 'iac-terraform/**/*.tf' | xargs -r dirname | sort -u)
for d in $PR_TF_DIRS; do checkov -d "$d" --quiet --compact; done

# Mixed-language semgrep on PR files (auto-config picks rules per language)
PR_FILES=$(git diff --name-only origin/main...HEAD)
[ -n "$PR_FILES" ] && semgrep --config auto --error $PR_FILES

# Secrets on PR files (very fast)
[ -n "$PR_FILES" ] && detect-secrets scan $PR_FILES
```

Triage anything Tier 1 surfaces using the same rules as the PR-touched bucket below. Fix or suppress before kicking off Tier 2 — it's wasteful to wait 15 minutes on a scan that you already know will flag the same `bandit B602` you can fix in 30 seconds.

If a tool isn't installed locally, skip it and tell the user — don't fail the phase. Tier 2 will catch it.

**Tier 2 — full ASH in the background (~10–15 min, source of truth).**

Once Tier 1 is clean, kick this off in the background and start drafting the PR body in the meantime:

```bash
pre-commit run --hook-stage manual --all-files ash
```

> **Why `--all-files`:** `make run-ash` invokes pre-commit, and pre-commit only runs hooks against files changed since HEAD by default. On a branch where you just committed, that's "no files" and the hook reports `(no files to check) Skipped` without producing a fresh report. The `--all-files` flag forces a full repo scan. The Makefile should pass this — if it doesn't, flag as a follow-up but don't block on it.

ASH bundles checkov, npm-audit, bandit, detect-secrets, cdk-nag, and semgrep — `CONTRIBUTING.md` requires it before any PR. Tier 1 catches the same issues for files you touched; Tier 2 catches whole-repo regressions (e.g. a synthesized CFN template that broke because of a config change three modules over).

### Partition findings by PR scope

After ASH finishes, read `.ash/ash_output/reports/ash.flat.json` (per-finding records) or the SARIF (`reports/ash.sarif`). For each finding, extract its file path and check membership in the PR file list:

- **PR-touched** — finding's file is in the PR diff. **These gate the PR.**
- **Pre-existing** — finding's file is NOT in the PR diff. Surface, don't block.

Special cases:

- **CFN templates** (`iac-cdk/cdk.out/*.template.json`) — synthesized outputs, not direct edits. Map them back to the PR by checking whether *any* `iac-cdk/{bin,lib}/**` file is in the PR diff. If yes, treat template findings as PR-touched. If no, pre-existing.
- **Terraform module-level findings** — checkov reports the `.tf` file directly. No mapping needed.
- **Vendored deps in `iac-terraform/build/` or `cdk.out/asset.*/`** — these should already be in `.ash/.ash.yaml`'s `ignore_paths`. If they appear, the ignore rules need updating; flag and treat as pre-existing.

### Triage PR-touched findings

- **Critical / High**: block. Either fix or suppress.
  - Real vulnerabilities (hardcoded secrets, SQL injection, overly permissive IAM, public S3 buckets without justification): fix.
  - False positives in this codebase's context (e.g. cdk-nag flagging a logging bucket that intentionally has no access logs, or `ecr:GetAuthorizationToken` which only accepts `Resource: "*"`): suppress inline with `NagSuppressions.addResourceSuppressions`, `# nosec`, `// nosemgrep`, or `# checkov:skip=…` **plus a one-line justification comment**. Never suppress without explaining why — silent suppressions rot.
- **Medium / Low**: surface in the PR body under "Known scan findings (non-blocking)". Don't auto-fix unless trivial.
- **Informational**: ignore unless the user asks.

### Triage pre-existing findings

Don't fix these in this PR — that's scope creep. Don't ignore them either. Bucket them by scanner + rule and put a one-line summary in the PR body under "Pre-existing repo-wide findings (not introduced by this PR)". The reviewer needs to know the scan ran and what it surfaced; they need to know what's *yours* vs. what was already there.

Example summary line: `Pre-existing: 5× checkov CKV_AWS_115 on Lambdas in iac-terraform/modules/data_processing/ (untouched by this PR).`

### Verify the gate

If you fixed or suppressed any PR-touched findings, re-run ASH and confirm the PR-touched count is zero. Commit fixes as `🔒 (security) address ASH findings on PR-touched files` or similar, separate from the code-review-fix commit.

## Phase 3 — Draft the PR message

Write the draft to `cache/pr-draft/<branch-slug>.md` (create the directory if missing; slugify the current branch name — e.g. `refactor/docker` → `refactor-docker.md`). Use the Write tool, not echo/heredoc. The file is the source of truth — the user opens it, edits, and pastes into GitHub. Do **not** create the PR yourself.

After writing, also print the title + body in the conversation as a fenced block so the user can review without opening the file, and tell them the file path. `cache/` is gitignored, so the draft stays local.

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

<only include if Phase 2 surfaced medium/low findings on PR-touched files
that the user accepted. Otherwise omit.>

## Pre-existing repo-wide findings (not introduced by this PR)

<only include if Phase 2 found anything in untouched code. One-line
summary per scanner+rule with file paths/counts — reviewer needs to
know what's pre-existing debt vs. what came in with this change.
Otherwise omit.>

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

After drafting, tell the user: "Draft written to `cache/pr-draft/<branch-slug>.md`. Copy this into `gh pr create --title '...' --body-file cache/pr-draft/<branch-slug>.md` or paste into the GitHub UI." Don't auto-push or auto-create.

## Notes on running checks

- `/code-review` and `make run-ash` both produce a lot of output. Don't dump it all into the conversation — summarize by severity and surface the actual findings.
- If either check fails to run (missing tooling, permission error), say so explicitly and ask the user how to proceed. Do not silently skip a phase and pretend the gate passed.
- Token cost matters: a typical run of this skill on a moderate PR is a few minutes of wall time and a meaningful chunk of tokens. If the diff is tiny (one-line fix), tell the user and ask whether they want the full pipeline or just the PR draft.
