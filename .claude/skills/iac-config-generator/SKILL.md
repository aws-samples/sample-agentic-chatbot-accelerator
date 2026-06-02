---
description: Generate matching CDK config.yaml and Terraform terraform.tfvars files from a short description of the features the user wants to deploy (Knowledge Base, Data Processing, AgentCore Runtime, Observability, Experiments, MCP servers, Evaluator, etc.). Use whenever the user says things like "generate a config", "create my config.yaml", "set up tfvars", "I want a config with KB enabled", "give me a deploy config for X", "what config do I need for Y", or any variation that asks for IaC inputs derived from project features. Outputs always go to cache/local-cfg/ at the repo root, in BOTH CDK and Terraform shapes, kept in sync.
user_invocable: true
---

# IaC config generator (CDK + Terraform, in sync)

This project ships two parallel IaC implementations — CDK is primary, Terraform mirrors it — and both are driven by the same conceptual feature set. Hand-writing `iac-cdk/bin/config.yaml` or `iac-terraform/terraform.tfvars` is error-prone: there are nested optional blocks, inter-feature dependencies (KB needs Data Processing, Experiments needs a VPC story, etc.), and the two formats name things differently (camelCase vs snake_case, YAML vs HCL, optional fields expressed as `?` in CDK types vs `optional()` / commented blocks in TF).

This skill turns a short user description into a matched pair of config files, written into the repo's `cache/local-cfg/` folder, ready for the user to copy into place.

## When to use

- The user wants to bootstrap a deployment with a specific feature set ("config for KB + observability", "tfvars without experiments", "give me the minimal config").
- The user is exploring scenarios and wants alternative configs side-by-side.
- The user is migrating between CDK and Terraform and needs the equivalent variables.
- Any phrasing that signals "generate config from features", even if the user doesn't name the file explicitly.

Don't use this skill for: editing `iac-cdk/bin/config.ts` defaults, generating runtime/Docker config, or producing AWS account-level setup (e.g. Bedrock model access). Those live elsewhere.

## How it works

### 1. Capture intent — short prompt + targeted follow-ups

Read what the user said. Most requests carry partial signal ("I want a config with KB and observability, no experiments"). Your job is to:

1. **Parse** what the user already declared.
2. **Identify gaps** that must be filled to produce a valid config — see the [Required-vs-optional table](#required-vs-optional).
3. **Ask only about what's missing or ambiguous.** Bundle related questions into one round-trip with `AskUserQuestion`. Don't interrogate the user for fields that have safe defaults — pick the default and tell them what you picked.

The features and their dependencies live in [references/feature-matrix.md](references/feature-matrix.md). Read it once at the start of a session — it's the source of truth for what features exist and how they interact.

### Required vs optional

| Always need from the user | Has safe default — only ask if relevant |
|---|---|
| `prefix` (resource name prefix, e.g. `dev`, `aca`, project name) | `aws_region` (us-east-1) |
| Which features to enable (KB, Observability, Experiments, AgentRuntime, MCP) | Lambda architecture (arm64) |
| For each enabled feature: the few fields that have no defaults (see feature-matrix.md) | Geo restrictions (off) |

If the user already said "minimal config" or "all defaults", don't ask anything — just pick safe defaults and produce the output.

### 2. Resolve dependencies

Some features imply others. Apply these silently and tell the user what you inferred:

- **Knowledge Base ⇒ Data Processing.** KB ingests from a data source prefix that the data processing pipeline produces. Enabling KB without Data Processing is a misconfig.
- **Experiments ⇒ VPC story.** Either `deployBatchInfrastructure: false` (CRUD only, no synthetic generation), `vpcId` set (reuse), or omit both (auto-create VPC). Pick based on the user's stated permissions / preferences.
- **AgentRuntime ⇒ at least one tool in `toolRegistry`.** If the user enables AgentRuntime but lists no tools, default to `invoke_subagent`.
- **AgentRuntime referencing `retrieve_from_kb` ⇒ KB must be enabled.** Otherwise drop the tool with a note.

If you have to drop or alter something the user requested, surface it explicitly in your final summary ("I had to disable X because Y").

### 3. Generate both files in sync

The two formats are not 1:1 string-for-string equivalent — they share semantics, not syntax. Use the field-mapping table in [references/cdk-tf-mapping.md](references/cdk-tf-mapping.md) so the generated files describe the same deployment.

Always emit both:
- `cache/local-cfg/config.yaml` — CDK shape (camelCase, YAML)
- `cache/local-cfg/terraform.tfvars` — Terraform shape (snake_case, HCL)

If `cache/` or `cache/local-cfg/` doesn't exist, create them. Use `mkdir -p`.

If files already exist there, **do not silently overwrite.** Show a diff-summary of what would change, then ask the user whether to overwrite, write to a sibling timestamped folder, or abort. The cache folder may contain hand-tuned configs from prior sessions and clobbering them is high-blast-radius.

### 4. Sanity-check before writing

Before the file is written, check it against these gotchas (none of these are caught by the type system):

- Model IDs: keep the `[REGION-PREFIX]` placeholder for cross-region inference profiles. Don't bake `us.` / `eu.` / `apac.` into the file unless the user asked for a specific region pin.
- `dataSourcePrefix` must match between `dataProcessingParameters` and `knowledgeBaseParameters` (default: `knowledge-base-data-source`).
- KB `chunkingStrategy.type` must match the `*ChunkingProps` block actually filled in (FIXED_SIZE → `fixedChunkingProps`, etc.).
- `toolRegistry` entries with `invokesSubAgent: true` only make sense for the agents-as-tools or graph patterns — if the user described single-agent deployment, drop them.
- Terraform side: comment out blocks for features the user didn't enable (don't emit empty objects — the variable defaults expect `null` or absent). Match the convention in `iac-terraform/terraform.tfvars.example`.
- `experimentsConfig` / `experiments_config`: respect the three-mode system (disabled → omit / null, auto-VPC → `{}`, reuse VPC → `{ vpc_id = "…" }`).

### 5. Report back

After writing, tell the user:
- Where the files landed (full paths from repo root).
- Which features were enabled, and any features they asked for that were dropped or altered, with reasons.
- The exact next step to use the config: e.g. `cp cache/local-cfg/config.yaml iac-cdk/bin/config.yaml` then `make deploy`, or `cp cache/local-cfg/terraform.tfvars iac-terraform/terraform.tfvars` then `make tf-deploy`.

Keep this summary short — the files are the artifact, the explanation is just orientation.

## Reference files

- [references/feature-matrix.md](references/feature-matrix.md) — Every feature, its required/optional fields, defaults, and inter-feature dependencies. Read this whenever the user names a feature you're not sure about.
- [references/cdk-tf-mapping.md](references/cdk-tf-mapping.md) — Field-by-field translation table between `config.yaml` and `terraform.tfvars`. Read this before generating to make sure the two outputs describe the same deployment.

These references are kept separate from `SKILL.md` because they're long, lookup-style content — keep `SKILL.md` skimmable and consult the references on demand.

## Why this design (theory of mind for the agent running this skill)

You're being asked to compress a feature description into a structured config. There's a temptation to ping-pong with the user for every field — don't. The user knows roughly what they want; they hit you up because they don't want to read 300 lines of `tfvars.example`. Pick sensible defaults aggressively, ask only when the choice has real consequences (e.g. KB embedding model dimension, Experiments VPC mode), and write the file. If you got something wrong, the diff-summary at write time gives the user a chance to course-correct before commitment. That's faster and friendlier than 12 questions up front.
