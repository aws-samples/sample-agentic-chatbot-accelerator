---
description: Propose a Terraform mirror plan for the most recent CDK commit on this branch. Use whenever the user has just committed CDK changes and says things like "mirror this to terraform", "propose tf changes", "what's the terraform equivalent", "tf follow-up", "sync to terraform", or any variation that signals they want the iac-terraform/ tree updated to match the latest CDK commit. Trigger this proactively the moment a CDK-only commit lands — the project policy is that every CDK change ships with a matching Terraform commit, so the user almost always wants this next.
user_invocable: true
---

# Mirror CDK commit → Terraform plan

This project ships two parallel IaC implementations. CDK is primary; Terraform is experimental but kept in sync. The convention is **one Terraform follow-up commit per CDK commit**. This skill produces the *plan* for that follow-up commit — it does not edit Terraform files.

## What this skill does

Reads the diff of `HEAD` on the current branch, maps each changed CDK file to its Terraform counterpart, and writes a file-level mapping with concrete HCL snippets the user can paste in. Any CDK change with no clean Terraform analog is flagged and skipped — partial mirrors are worse than honest gaps.

## When to use

- Right after the user commits CDK-only changes.
- When the user explicitly asks to mirror, sync, or translate CDK changes to Terraform.
- As `/mirror-cdk-to-terraform` (or whatever the slash command resolves to).

If the user passes a different commit (SHA, range), accept it and use that instead of `HEAD`.

## The CDK ↔ Terraform mapping

The two trees mirror each other by feature, with a naming convention:

| CDK | Terraform |
|---|---|
| `iac-cdk/lib/<feature-name>/` | `iac-terraform/modules/<feature_name>/` (hyphens → underscores) |
| `iac-cdk/lib/aca-stack.ts` | `iac-terraform/main.tf` (root composition) |
| `iac-cdk/lib/builder-stack.ts` | `iac-terraform/build/` + `iac-terraform/scripts/` (CodeBuild orchestration) |
| `iac-cdk/lib/shared/types.ts` + `iac-cdk/bin/config.ts` | `iac-terraform/variables.tf` + `iac-terraform/terraform.tfvars[.example]` |
| `iac-cdk/bin/aca.ts` (CDK aspects, app entrypoint) | usually no direct analog — flag as gap |
| `iac-cdk/test/**` | no analog (Terraform has no Jest equivalent here) — skip silently |
| `src/**` (Lambda code, Docker, React, GraphQL schema) | unchanged across IaC; do **not** propose Terraform edits for these — they're shared runtime |

When a CDK construct directory exists but the matching Terraform module doesn't (or vice versa), call this out — it usually means the feature is CDK-only or TF-only and needs a human decision.

## Procedure

### 1. Read the commit

Run these in parallel:
- `git rev-parse HEAD` (or use the user-provided SHA)
- `git log -1 --format='%H%n%s%n%n%b' <sha>` — capture the message for context
- `git show --stat <sha>` — get the changed-file list
- `git show <sha> -- 'iac-cdk/' ':(exclude)iac-cdk/test/**' ':(exclude)iac-cdk/package*.json' ':(exclude)iac-cdk/cdk.out/**'` — the actual CDK diff

If `iac-cdk/` has no changes in this commit, stop and tell the user there is nothing to mirror. Do not invent work.

If the commit also touches `iac-terraform/`, that's unusual for the workflow — note it in the output, but still produce the plan for any remaining CDK gap.

### 2. Classify each changed CDK file

For every file under `iac-cdk/`, decide:

- **Mirrorable** — the file maps to a known Terraform location per the table above. Read the target Terraform file(s) so the proposed HCL fits the existing style (variable names, resource naming, tags, locals).
- **No analog** — e.g., a CDK aspect, `cdk-nag` suppression, `bin/aca.ts` wiring, Jest test, or pure TypeScript scaffolding. Flag it, give a one-line reason, do not invent Terraform.
- **Shared runtime** — anything under `src/` shouldn't appear here, but if it sneaks in (e.g., a CDK file imports a path from `src/`), note that the *path* is shared and only the IaC-side reference needs updating.

### 3. Write concrete Terraform snippets

For each mirrorable change, produce:

- The **target file path** in `iac-terraform/` (create-new vs. edit-existing).
- A **diff-style HCL snippet** (or full block for new files) showing what to add/change/remove.
- If the CDK change introduces a new variable / config knob, propose the `variables.tf` and `terraform.tfvars.example` updates.
- If the CDK change is a CDK-managed default (e.g., a runtime upgrade aspect, an L2 default), call out the equivalent Terraform argument explicitly — Terraform does not get those defaults for free.

Match the existing Terraform module's conventions by reading neighbour `.tf` files first. Do not introduce a new style.

### 3a. Verify against documentation (only for new resource types)

If — and only if — the plan would introduce an `aws_<resource>` type that does **not already appear** in the target Terraform module, verify the argument names and block shape against authoritative docs before writing the HCL. Routine mirrors (adding a tag, an env var, an IAM action to an existing resource) skip this step entirely; the cost-benefit only flips when you'd otherwise be guessing.

Run these two lookups in parallel:

1. **Terraform provider docs** — the source of truth for argument names, block vs. attribute, required-vs-optional, and the minimum provider version that introduced the resource. Prefer in this order:

   - **Terraform MCP server** (`mcp__terraform__*`) if available in this session — it's the structured Registry-backed lookup. Typical flow: `search_providers` / `get_provider_details` to confirm the provider, then `resolveProviderDocID` + `getProviderDocs` for the specific `aws_<resource>` page. This is configured in `.mcp.json` for this repo (`hashicorp/terraform-mcp-server`); if `ToolSearch` for "terraform" returns no tools, the server isn't running and you should fall back to one of the next options. (Note: connecting an MCP server requires a Claude Code session restart after `.mcp.json` is written.)
   - **Provider source on GitHub** (most reliable when MCP isn't available) — the Registry's HTML pages render via JS, so `WebFetch` against `registry.terraform.io` and `developer.hashicorp.com/terraform/providers/...` typically returns blank or 404. Go straight to the Go source. For the AWS provider:
     ```
     https://api.github.com/repos/hashicorp/terraform-provider-aws/contents/internal/service/<service>
     ```
     to list files, then read the resource definition raw:
     ```
     https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/internal/service/<service>/<resource>.go
     ```
     Look for `schema.Schema` / `schema.Attribute` / `schema.StringAttribute` blocks and `@FrameworkResource`/`@SDKResource` annotations to get exact attribute names, types, and `Required`/`Optional`/`Computed`/`RequiresReplace` flags. Cross-reference the Go model struct (`tfsdk:"..."` tags) for nested object fields. This is what `WebFetch` should target by default.
   - **Provider CHANGELOG** — `https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/CHANGELOG.md` (or `v<version>` tag). Use this to find the first version that introduced the resource and bump `iac-terraform/versions.tf` accordingly. If the resource is on `main` but not yet in the changelog, say so explicitly — that's a "verify on apply" caveat, not a guess.

   Either way, ask for: the full argument list, the block structure for nested config, and which fields are `RequiresReplace` (drift in those forces destroy+recreate, which matters a lot more in TF than in CDK). If the resource is brand-new, also check `iac-terraform/versions.tf` — the `aws` provider constraint may need bumping in the same TF commit, and that bump belongs in the plan.

2. **AWS service docs** (via `aws-mcp`) — `aws___search_documentation` then `aws___read_documentation` for: the exact IAM action names, any service-level constraints (naming length limits, regional availability, encryption rules) that the CDK construct hides but Terraform exposes raw. Use this when the CDK change adds IAM perms for a new service, or wires up a service whose behavior the snippet depends on.

Encode what you learn directly into the snippet — cite the Registry URL and any AWS doc page in a one-line comment if a future reader would otherwise wonder where an unusual argument came from. Do not paste long doc excerpts into the report; the snippet itself is the artifact.

If a doc lookup fails or returns ambiguous output (provider page 404s, AWS doc search returns nothing relevant), say so honestly in the report and mark the snippet as "best-effort, verify on apply" rather than presenting a guess as authoritative.

### 4. Report

Output a single markdown report with this structure:

```
# Terraform mirror plan for <short-sha> "<commit-subject>"

## Summary
- N CDK files changed → M Terraform files to update, K gaps flagged.

## Mirrorable changes
### `iac-cdk/lib/foo/bar.ts` → `iac-terraform/modules/foo/bar.tf`
<one-line description of the change>

```hcl
# iac-terraform/modules/foo/bar.tf
<concrete snippet>
```

(repeat per file)

## Gaps (no clean Terraform equivalent)
- `iac-cdk/bin/aca.ts` — CDK aspect `LambdaNodejsRuntimeUpgrader`. Terraform has no aspect mechanism; would need to set `runtime = "nodejs24.x"` on each aws_lambda_function individually. **Recommend:** manual review.
- (repeat)

## Suggested follow-up commit message
<emoji> (terraform): mirror <cdk-commit-subject>

Mirrors <short-sha> on the Terraform side. <one-line why if non-obvious>.
```

The commit-message suggestion follows this repo's gitmoji + Conventional Commits style (see the `commit` skill). Use `🔧` or `♻️` or whatever matches the CDK commit's intent.

### 5. Hand off

Do not stage, edit, or commit Terraform files in this skill. The user explicitly opted for plan-only — they will apply the changes themselves. End by telling them: "Plan ready. Apply, then `/commit` for the Terraform follow-up."

## Why these constraints

- **Plan only, no edits.** Terraform changes can interact with state in subtle ways (resource renames trigger destroy+recreate). The user wants to see and apply them deliberately, not have them auto-applied.
- **Flag, don't fudge.** A best-effort Terraform stub for a CDK aspect or a cdk-nag suppression silently drifts the two trees apart. Honest gaps are easier to maintain than near-misses.
- **One commit, one mirror.** Mirroring per-commit (not per-PR) keeps the two histories aligned and makes `git log -- iac-terraform/` readable as "what changed in TF and why". The matching CDK SHA is the durable anchor in the suggested commit message.
