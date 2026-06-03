# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Full-stack accelerator for building agentic chatbots on AWS. Two parallel IaC implementations (CDK is primary, Terraform is experimental) deploy: a React web UI, AppSync GraphQL API, AgentCore-hosted Strands Agents in Docker containers, optional Bedrock Knowledge Base, and a Batch-based experiments runner.

## Common commands

All `make` commands run from the **repo root**.

### CDK (default)
- `make deploy [PROFILE=…] [REGION=…]` — three-phase deploy: BuilderStack → `iac-cdk/scripts/build.sh` (parallel CodeBuild) → AcaStack. Deps install automatically; **no local Docker/Python required**.
- `make destroy [PROFILE=…]` — destroys AcaStack then BuilderStack (reverse of deploy).
- `make clean-build` — `git clean -fx iac-cdk/{lib,bin}/` to drop generated GraphQL artifacts.
- `cd iac-cdk && npm run gen` — regenerate Amplify GraphQL TS types (also run by `make deploy` via `gen-graphql`).
- `cd iac-cdk && npx cdk deploy '*-builder' --require-approval never` — deploy only Phase 1.
- `cd iac-cdk && npm test` — Jest tests for CDK constructs (`iac-cdk/test/`).

### Terraform (experimental)
- `make tf-deploy` / `make tf-deploy-auto` — uses CodeBuild for all artifact builds. Settings come from `iac-terraform/terraform.tfvars`.
- `make tf-plan` / `make tf-destroy` / `make tf-lint` (= fmt + validate + checkov).
- `make tf-build-layers` / `make tf-build-image` are **legacy** local Docker fallbacks.

### Frontend dev loop
- After deploy, copy `<cloudfront-url>/aws-exports.json` into `src/user-interface/react-app/public/aws-exports.json`, then in that directory: `npm run dev` (Vite). `npm run build:dev` overwrites `aws-exports.json`, so re-populate it after.

### Code quality
- `make precommit-run` — runs all pre-commit hooks (Black, Ruff, isort, Prettier, terraform fmt/validate, typos).
- `make run-ash` — manual security scan (ASH: checkov, npm-audit, bandit, detect-secrets, cdk-nag, semgrep). Required before opening a PR.
- `make tf-checkov` — Checkov scan over Terraform only.

### Python (for IDE/linters only — not runtime)
- `make init-python-env` (`uv venv`) → `make install-python-packages` (`uv sync`). Python 3.13+ via `uv`. Lambdas execute on AWS, not locally.

## Architecture (big picture)

This is a **3-stack-equivalent CDK app** (`iac-cdk/bin/aca.ts`):

1. **BuilderStack** (`iac-cdk/lib/builder-stack.ts`) — defines CodeBuild projects, ECR repos, and S3 artifact buckets. Deployed first.
2. **`iac-cdk/scripts/build.sh`** — diffs each CodeBuild project's source vs. last successful build, triggers only changed ones in parallel, polls until done. Lives between Phase 1 and Phase 3 — it is **not** a CDK construct, so editing it changes deploy behavior without changing the synthesized template.
3. **AcaStack** (`iac-cdk/lib/aca-stack.ts`) — application stack that *consumes* artifacts (ECR images, Lambda layer zips, React build) produced by Phase 2.

Two CDK aspects run in `aca.ts`: `LambdaNodejsRuntimeUpgrader` (forces all `nodejs*` Lambdas to `nodejs24.x`, including framework-managed ones), then `AwsSolutionsChecks` (cdk-nag). Order matters — runtime upgrade must happen before nag validation.

### Runtime data plane
The browser talks to AgentCore **directly over WebSocket** (`wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/ws`) using a SigV4-signed presigned URL. AppSync/Lambda are **not** in the chat data path — they are only used for CRUD (sessions, agent config, evaluations) and a *side-channel* for AI-rephrased tool-action descriptions (SNS → `agentTools` topic → Agent Tools Handler Lambda → `chatMessages` topic → Outgoing Message Handler → AppSync subscription → browser).

FastAPI inside the AgentCore container exposes:
- `/ws` — text + voice (`voice_init` flips into Nova Sonic BidiAgent mode)
- `/invocations` — HTTP POST + SSE for orchestrator → sub-agent calls

### Agent patterns = different containers
Each agentic pattern has its own Docker image, defined in `src/agent-core/`:
- `docker/` — single agent
- `docker-agents-as-tools/` — orchestrator + sub-agents
- `docker-swarm/` — collaborative swarm
- `docker-graph/` — directed-graph workflow

Shared agent code (BidiAgent adapter, session history, MCP client) lives in `src/agent-core/shared/`.

### Source vs. infra mapping
`src/<feature>/` holds runtime code (Python Lambdas, Docker, React, GraphQL schema). `iac-cdk/lib/<feature>/` holds the CDK construct that wires it up. The two trees mirror each other (e.g., `src/data-processing/` ↔ `iac-cdk/lib/data-processing/`). Terraform mirrors the same in `iac-terraform/modules/`.

### Optional features (configuration-gated)
Driven by `iac-cdk/bin/config.yaml` (overrides defaults in `iac-cdk/bin/config.ts`; types in `iac-cdk/lib/shared/types.ts`). When a config block is omitted, the corresponding construct is **not instantiated** — UI nav items hide and the agent wizard skips related steps.
- `dataProcessingParameters` + `knowledgeBaseParameters` → document pipeline + Bedrock KB
- `agentRuntimeConfig` → pre-create an AgentCore runtime via CDK (else use Agent Factory UI)
- `agentCoreObservability` → X-Ray Transaction Search + tracing
- `experimentsConfig.deployBatchInfrastructure: false` or `vpcId` → controls Batch synthetic-data generation (requires VPC)

`config.yaml` is **not git-versioned**; deploys without it use `config.ts` defaults.

### GraphQL codegen quirk
Two Lambdas share a `graphql.ts` utility. The Makefile target `copy-graphql-util` copies `outgoing-message-handler/graphql.ts` → `notify-runtime-update/graphql.ts` before every deploy. Edit the source (`outgoing-message-handler`); the copy is overwritten.

## Coding standards
- **Python**: PEP 8, type hints, Black (line length 88 via isort/black profile — `pyproject.toml` says 120 in CONTRIBUTING.md but tooling enforces 88), Ruff (E, F; E501 ignored). Use AWS Lambda Powertools for logging/tracing.
- **TypeScript**: Prettier + ESLint. CDK in TS. React app uses functional components + Cloudscape Design System.
- **Comments**: explain *why*, not *what*.

## Security & production safety
- Run `make run-ash` before any PR. Review IAM/Cognito/AppSync auth/Lambda perms/S3 policies for least-privilege.
- This accelerator is a **proof-of-value, not production-ready** — apply AWS Shared Responsibility before shipping anything user-facing.
