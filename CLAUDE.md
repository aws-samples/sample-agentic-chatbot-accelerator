# CLAUDE.md

Guidance for Claude Code working in this repository. Assume you can read the Makefile, `package.json`, and `pyproject.toml` — this file records what those files *don't* tell you.

Deep context lives next to the code it constrains, and is loaded when you work in that directory:

| Where | What it covers |
|---|---|
| [`src/agent-core/CLAUDE.md`](src/agent-core/CLAUDE.md) | the runtime contract, agent patterns, A2A dual runtimes, config bundles, model dispatch |
| [`src/api/CLAUDE.md`](src/api/CLAUDE.md) | AppSync's actual role, the `graphql.ts` copy footgun, state machines |
| [`src/user-interface/react-app/CLAUDE.md`](src/user-interface/react-app/CLAUDE.md) | frontend dev loop, the `aws-exports.json` trap, the direct chat socket |
| [`iac-cdk/CLAUDE.md`](iac-cdk/CLAUDE.md) | aspect order, config-gated features, the cdk-nag suppression footgun |
| [`iac-terraform/CLAUDE.md`](iac-terraform/CLAUDE.md) | mirroring rules, root-level side effects, `count` re-addressing |
| [`cli/CLAUDE.md`](cli/CLAUDE.md) | the no-AWS-credentials constraint, config file, protocol gotchas |

## Project

Full-stack accelerator for building agentic chatbots on AWS. Deploys a React web UI, AppSync GraphQL API, AgentCore-hosted Strands Agents in Docker containers, an optional Bedrock Knowledge Base, and a Batch-based experiments runner. Two parallel IaC trees: **CDK is primary, Terraform is experimental** and must be kept in sync (`/mirror-cdk-to-terraform` after every CDK commit). `cli/` holds `aca`, a Rust terminal chat client — the only Rust in the repo.

This is a **proof-of-value, not production-ready** codebase.

## Commands

All `make` targets run from the **repo root** (Terraform equivalents are `tf-`-prefixed).

- `make deploy [PROFILE=…] [REGION=…]` — three-phase deploy (see below). No local Docker or Python needed. `make destroy` reverses it.
- Gates before any PR: `make precommit-run`, `make run-ash` (checkov, npm-audit, bandit, detect-secrets, cdk-nag, semgrep), `cd iac-cdk && npm test`, and `make cli-lint` if `cli/` changed (clippy runs `-D warnings`, so a warning fails).
- Python (`make init-python-env` → `make install-python-packages`, `uv`, 3.13+) is for IDE and linters only. Lambdas and containers execute on AWS; there is no local runtime.

## Architecture

### Three-phase deploy
1. **BuilderStack** (`iac-cdk/lib/builder-stack.ts`) — CodeBuild projects, ECR repos, S3 artifact buckets.
2. **`iac-cdk/scripts/build.sh`** — diffs each CodeBuild project's source against its last successful build, triggers only changed ones in parallel, polls to completion. This is a shell script, **not** a CDK construct: editing it changes deploy behavior without changing the synthesized template.
3. **AcaStack** (`iac-cdk/lib/aca-stack.ts`) — the application, which *consumes* the artifacts Phase 2 produced.

### The data plane skips AppSync
The browser talks to AgentCore **directly over WebSocket** (`wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/ws`) via a SigV4 presigned URL. AppSync and Lambda are **not** in the chat path — chat tokens *and* tool-step updates stream over that same socket. AppSync handles CRUD and status notifications.

### Source ↔ infra mapping
`src/<feature>/` is runtime code; `iac-cdk/lib/<feature>/` is the construct that wires it; `iac-terraform/modules/<feature>/` mirrors the same. The trees are meant to stay parallel.

### Features are configuration-gated
`iac-cdk/bin/config.yaml` overrides `iac-cdk/bin/config.ts`; types in `iac-cdk/lib/shared/types.ts`. **When a config block is omitted the construct is not instantiated** — UI nav items hide and wizard steps disappear. `config.yaml` is not git-versioned, so a plain clone deploys `config.ts` defaults. Use `/iac-config-generator` to produce matching CDK + Terraform configs. The individual gates are listed in [`iac-cdk/CLAUDE.md`](iac-cdk/CLAUDE.md).

## Conventions

- **Python**: PEP 8, type hints, Black + isort (88 cols), Ruff (E, F; E501 ignored), AWS Lambda Powertools for logging and tracing. Google-style docstrings (`Args:` / `Returns:` / `Raises:`, `name (type): description`) — match `src/agent-core/shared/`.
- **TypeScript**: Prettier + ESLint. React uses functional components and Cloudscape.
- **Comments explain *why***. The existing code comments carry a lot of hard-won context (protocol quirks, AWS bugs, deliberate trade-offs) — read them before "simplifying" something that looks redundant, and preserve them when refactoring.
- Commit each completed task rather than batching.

## Decisions and specs

- `docs/adr/` — accepted architecture decisions. Read the relevant one before revisiting a design; these are settled, not open questions.
- `local/user-stories/<name>/` — AI-DLC artifacts (`story.md` → `design-doc.md` → `tasks/`), driven by the `/ai-dlc`, `/story-new`, `/story-refine`, `/design-doc`, `/tasks` skills.
- `docs/src/` — user-facing documentation; keep it aligned when behavior changes.

## Security

Review IAM, Cognito, AppSync auth, Lambda permissions, and S3 policies for least privilege on every change. Run `make run-ash` before opening a PR (`/prep-pr` does this plus review).
