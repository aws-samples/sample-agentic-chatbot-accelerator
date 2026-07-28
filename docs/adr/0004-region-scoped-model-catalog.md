# 0004 — Region-scoped supported-model catalog in IaC

- Status: Accepted
- Date: 2026-07-28
- Context: [region-supported-models story](../../local/user-stories/region-supported-models/story.md), [design doc](../../local/user-stories/region-supported-models/design-doc.md)
- Supersedes: the "No IaC or schema change" consequence of [ADR-0003](0003-mantle-provider-dispatch.md)

## Context

The selectable chat-model set was already deployment-controlled — operators pick from a dropdown, never free-form a `modelId` — but the list was a flat `Record<displayName, modelId>` in configuration, duplicated across `bin/config.ts`, `bin/config.yaml`, and `bin/config-demo.yaml`. Two facts made that carrier the wrong place for the data:

1. **The `[REGION-PREFIX]` template leaked.** Configured ids embedded a `[REGION-PREFIX]` token that the frontend substituted with `region.split("-")[0]`. The abstraction is false: Mantle-tail ids (`anthropic.claude-sonnet-5`, `xai.grok-4.3`, `google.gemma-4-31b`) take **no** geo prefix, while Converse ids (`amazon.nova-2-lite-v1:0`) do. A single template cannot express both id spaces.
2. **Availability is a region property, not a per-deployment preference.** Bedrock/Mantle regional availability is irregular and **not derivable from the id** (see [ADR-0003](0003-mantle-provider-dispatch.md)). A config knob let an operator offer a model the deploy region does not serve, producing runtime 400s from an unserved id — a foot-gun the configuration surface actively invited.

Keeping the served set in three config files therefore duplicated data that is really a platform fact, and left correctness (the region↔model relationship) unenforced until runtime.

## Decision

1. **Hard-code a region→models map (`SUPPORTED_MODELS`) in `iac-cdk/lib/shared/supported-models.ts`** as the single source of truth. Ids are **literal** — no `[REGION-PREFIX]` token anywhere. The module also exports `modelsForRegion(region)` (flat slice, throws with the supported-region list on miss) and `assertRegionSupported(region)`.
2. **Remove `supportedModels` from configuration** — the field is dropped from `SystemConfig` / `EvaluatorConfig` / `ExperimentsConfig` in `types.ts` (the interfaces stay; they retain their other fields) and the blocks are deleted from `config.ts`, `config.yaml`, and `config-demo.yaml`.
3. **Strict synth guard in `bin/aca.ts`.** The deploy region is resolved from `process.env.CDK_DEFAULT_REGION` (fallback `AWS_REGION`) — the only concrete region available at synth, since the stacks are env-agnostic and `cdk.Aws.REGION` / `Stack.region` are unresolved tokens. The region must be a key of `SUPPORTED_MODELS`; an unsupported or unset region **fails synth** with a clear message. No `default` key, no legacy fallback.
4. **One shared constant serves chat, evaluator, and experiments.** `user-interface/index.ts` emits `modelsForRegion(region)` into `aws-exports.json` for all three surfaces; a caller needing a curated subset filters at its own call site rather than maintaining a parallel map. The frontend contract (`aws_bedrock_supported_models: Record<displayName, literalId>`) is unchanged except that the `[REGION-PREFIX]` substitution disappears from the wizard, evaluator wizard, and `agent-config-view.getModelName`.

## Consequences

- **Positive:** The wizard only ever offers models actually served in the deploy region — no runtime 400s from an unserved id. The three-way config duplication collapses to one place, and the frontend loses the fragile prefix substitution.
- **Positive:** A deploy to an unsupported (or unset) region fails fast at synth with the supported-region list, instead of surfacing as a runtime error after a successful deploy.
- **Negative / trade-off (breaking config change for operators):** `supportedModels` is no longer a configurable knob. Adding a region or a model is now a **code edit** to `SUPPORTED_MODELS` plus a redeploy, where it used to be a config edit. This is intended — the served set is a platform fact, not a per-deployment preference — but operators upgrading across this change must delete any `supportedModels` block from their `config.yaml` (a stale block is silently ignored by the `js-yaml` CORE_SCHEMA loader) and edit the constant instead.
- **Neutral:** The backend `create_model` / Mantle dispatch is **unchanged** — it routes on the id string regardless of where the list came from ([ADR-0003](0003-mantle-provider-dispatch.md) stays intact). This is a pure config/IaC-plane change: no backend, IAM, or runtime change. It supersedes only ADR-0003's now-stale "No IaC or schema change / `supportedModels` stays `Record<string, string>`" consequence.
- **Deferred:** The Terraform mirror is a separate follow-up (hard-coded `locals` map + a region precondition), tracked via `/mirror-cdk-to-terraform`. Until it lands, only the CDK path enforces the region guard.
- **Deferred:** This story ships the mechanism plus a seed map; populating the real exhaustive per-region model lists is a data task the operator owns.
