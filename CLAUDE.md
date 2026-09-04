# CLAUDE.md

Guidance for Claude Code working in this repository. Assume you can read the Makefile, `package.json`, and `pyproject.toml` — this file records what those files *don't* tell you.

## Project

Full-stack accelerator for building agentic chatbots on AWS. Deploys a React web UI, AppSync GraphQL API, AgentCore-hosted Strands Agents in Docker containers, an optional Bedrock Knowledge Base, and a Batch-based experiments runner. Two parallel IaC trees: **CDK is primary, Terraform is experimental** and must be kept in sync (`/mirror-cdk-to-terraform` after every CDK commit). `cli/` holds `aca`, a Rust terminal chat client — the only Rust in the repo.

This is a **proof-of-value, not production-ready** codebase.

## Commands

All `make` targets run from the **repo root** (Terraform equivalents are `tf-`-prefixed; `tf-build-layers` / `tf-build-image` are legacy local-Docker fallbacks).

- `make deploy [PROFILE=…] [REGION=…]` — three-phase deploy (see Architecture). No local Docker or Python needed. `make destroy` reverses it.
- Frontend dev loop: copy `<cloudfront-url>/aws-exports.json` into `src/user-interface/react-app/public/aws-exports.json`, then `npm run dev` in that directory. `npm run build:dev` overwrites `aws-exports.json` — re-populate after.
- Gates before any PR: `make precommit-run`, `make run-ash` (checkov, npm-audit, bandit, detect-secrets, cdk-nag, semgrep), `cd iac-cdk && npm test`, and `make cli-lint` if `cli/` changed (clippy runs `-D warnings`, so a warning fails).
- Python (`make init-python-env` → `make install-python-packages`, `uv`, 3.13+) is for IDE and linters only. Lambdas and containers execute on AWS; there is no local runtime.

## Architecture

### Three-phase deploy
1. **BuilderStack** (`iac-cdk/lib/builder-stack.ts`) — CodeBuild projects, ECR repos, S3 artifact buckets.
2. **`iac-cdk/scripts/build.sh`** — diffs each CodeBuild project's source against its last successful build, triggers only changed ones in parallel, polls to completion. This is a shell script, **not** a CDK construct: editing it changes deploy behavior without changing the synthesized template.
3. **AcaStack** (`iac-cdk/lib/aca-stack.ts`) — the application, which *consumes* the artifacts Phase 2 produced.

Two aspects run in `iac-cdk/bin/aca.ts`: `LambdaNodejsRuntimeUpgrader` (forces every `nodejs*` Lambda to `nodejs24.x`, including framework-managed ones) then `AwsSolutionsChecks`. Order matters — the upgrade must precede nag validation.

### Runtime data plane
The browser talks to AgentCore **directly over WebSocket** (`wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/ws`) via a SigV4 presigned URL. AppSync and Lambda are **not** in the chat path — chat tokens *and* tool-step updates stream over that same socket. AppSync handles CRUD (sessions, agents, evaluations) and status notifications (e.g. `notify-runtime-update` → `publishRuntimeUpdate` → subscription → browser).

FastAPI inside the container exposes `/ws` (text, plus voice when the first message is `voice_init`, which flips into a Nova Sonic BidiAgent) and `/invocations` (HTTP + SSE).

### Agent patterns are separate containers
`src/agent-core/docker{,-agents-as-tools,-swarm,-graph}` — single agent, orchestrator + sub-agents, swarm, directed graph. Shared code (BidiAgent adapter, session history, MCP client, model factory, A2A) lives in `src/agent-core/shared/`.

### Dual-runtime sub-agents (A2A)
Every SINGLE-image agent is created as **two AgentCore runtimes**: an `HTTP` one the UI talks to, and an `A2A` twin named `<agentName>_a2a`. Orchestrators reach sub-agents over A2A (`A2AClientToolProvider`, SigV4-signed against `bedrock-agentcore`); the UI never uses the twin. A Step Function (`src/api/state-machines/create-agentcore-runtime.json`) fans out to both branches with one shared timestamp. Runtime names must match `^[a-zA-Z][a-zA-Z0-9_]{0,47}$` — no hyphens, 48 chars including the `_a2a` suffix.

### Agent config lives in AgentCore configuration bundles
Not DynamoDB. Containers read config with `get_configuration_bundle_version(BUNDLE_ID, BUNDLE_VERSION)` through the **control plane**, with those two values injected as env vars; there is no Gateway and no baggage in this data plane. A failed or empty fetch **raises and the container refuses to start** — deliberately fail-fast, no fallback to embedded defaults. See ADR-0001 and ADR-0002 before changing any of this.

### Models: catalog and provider dispatch
`create_model` in `src/agent-core/shared/base_factory.py` dispatches four ways by provider, including Bedrock Mantle for OSS models; the UI catalog is region-scoped (ADR-0003, ADR-0004). Reasoning/effort parameters differ per model family and **AWS documentation has repeatedly been wrong about them** — validate against a live probe before trusting a model card, and record the finding next to the capability entry rather than deleting it.

### Source ↔ infra mapping
`src/<feature>/` is runtime code; `iac-cdk/lib/<feature>/` is the construct that wires it; `iac-terraform/modules/<feature>/` mirrors the same. The trees are meant to stay parallel.

### Optional features (configuration-gated)
`iac-cdk/bin/config.yaml` overrides `iac-cdk/bin/config.ts`; types in `iac-cdk/lib/shared/types.ts`. **When a config block is omitted the construct is not instantiated** — UI nav items hide and wizard steps disappear. `config.yaml` is not git-versioned, so a plain clone deploys `config.ts` defaults. Use `/iac-config-generator` to produce matching CDK + Terraform configs.

Gates worth knowing: `dataProcessingParameters` + `knowledgeBaseParameters` (document pipeline + KB), `agentRuntimeConfig` (pre-create a runtime instead of using the Agent Factory UI), `agentCoreObservability` (X-Ray Transaction Search), `evaluatorConfig`, `experimentsConfig` (Batch synthetic data — needs a VPC), `bedrockAccessRoleArn` (cross-account Bedrock; only assumed on the BedrockModel branch), and the `toolRegistry` / `mcpServerRegistry` / `stateClassRegistry` / `deterministicNodeRegistry` / `structuredOutputRegistry` lists the wizard reads for discovery.

### GraphQL codegen footgun
`make copy-graphql-util` copies `src/api/functions/outgoing-message-handler/graphql.ts` → `notify-runtime-update/graphql.ts` before every deploy. Edit the source; the copy is overwritten.

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
