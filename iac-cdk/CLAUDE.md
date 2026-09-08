# iac-cdk — the primary IaC tree

CDK is the source of truth for infrastructure; `iac-terraform/` mirrors it and is experimental. Anything landed here has to be mirrored (see `iac-terraform/CLAUDE.md`).

Gate before a PR: `cd iac-cdk && npm test`, plus `make run-ash` from the repo root (cdk-nag runs there).

## Two stacks, and a shell script between them

1. **`lib/builder-stack.ts`** — CodeBuild projects, ECR repos, S3 artifact buckets. Nothing else.
2. **`scripts/build.sh`** — diffs each CodeBuild project's source against its last successful build, triggers only the changed ones in parallel, polls to completion. It is a **shell script, not a construct**: editing it changes deploy behaviour without changing the synthesized template, so a template diff will not show your change. It also discovers projects at runtime (`aws codebuild list-projects` filtered by stack name), which is why a project that is never created needs no special handling here.
3. **`lib/aca-stack.ts`** — the application, *consuming* the artifacts phase 2 produced.

## Aspect order in `bin/aca.ts`

`LambdaNodejsRuntimeUpgrader` (forces every `nodejs*` Lambda to `nodejs24.x`, including the framework-managed ones) runs **before** `AwsSolutionsChecks`. The order is load-bearing: nag validates what the upgrader produced, so swapping them makes the upgrade invisible to the checks.

`assertRegionSupported(deployRegion)` also runs here, and narrows the region to a concrete `string` for everything downstream.

## Optional features are gated by config

`bin/config.yaml` overrides `bin/config.ts`; the types live in `lib/shared/types.ts`. **When a config block is omitted the construct is not instantiated** — UI nav items hide and wizard steps disappear with it.

`config.yaml` is not git-versioned, so a plain clone deploys `config.ts` defaults. That has one consequence worth remembering in tests: `getConfig()` reads a developer's real `config.yaml` when one exists, so a test that calls it is not deterministic across machines. Build the config object explicitly instead. Use `/iac-config-generator` to produce matching CDK + Terraform configs.

Gates worth knowing: `dataProcessingParameters` + `knowledgeBaseParameters` (document pipeline + KB), `agentRuntimeConfig` (pre-create a runtime instead of using the Agent Factory UI), `agentCoreObservability` (X-Ray Transaction Search), `evaluatorConfig`, `experimentsConfig` (Batch synthetic data — needs a VPC), `bedrockAccessRoleArn` (cross-account Bedrock; only assumed on the `BedrockModel` branch), and the `toolRegistry` / `mcpServerRegistry` / `stateClassRegistry` / `deterministicNodeRegistry` / `structuredOutputRegistry` lists the wizard reads for discovery.

`deployUserInterface` is the one gate that is a **boolean, defaulting to true**, rather than a block whose absence disables it — so absent means on, normalized by `withDefaults()` in `bin/config.ts` and re-defaulted with `?? true` at each read site. It has to be threaded into `BuilderStack` as well as `AcaStack` (`ReactAppBuild` lives in the former), where it is a *required* prop: a default there could silently disagree with the one `AcaStack` read. Flipping it off deletes a live website bucket and its contents.

## The cdk-nag footgun when you gate something

`NagSuppressions.addResourceSuppressionsByPath` on a path that **no longer resolves fails synth**. So a construct that becomes conditional must take its suppressions into the same branch — including suppressions on CDK's framework-managed singletons, which exist only because some construct in the stack pulled them in.

`aca-stack.ts` already does this for `BucketNotificationsHandler`, which exists only when `dataProcessing` is defined: the paths are assembled inside the `if`, and even the `DefaultPolicy` path is probed with `tryFindChild` before being suppressed, because CDK only creates it when the role gets an inline policy. Copy that shape rather than inventing a new one.

## Conventions

Prettier + ESLint. Constructs follow `iac-cdk/lib/<feature>/` mirroring `src/<feature>/`; keep the trees parallel.
