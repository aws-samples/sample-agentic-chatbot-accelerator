/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

/**
 * Model ids Bedrock/Mantle serves per region, keyed by region then display name.
 * Ids are LITERAL and ready to use — no `[REGION-PREFIX]` token, no runtime
 * substitution. A given display name may map to a different literal id per region
 * (e.g. a geo-prefixed Converse id in one region, an unprefixed Mantle id in another).
 */
export type RegionKeyedModels = Record<string, Record<string, string>>;

/**
 * The single source of truth for selectable chat models, shared by chat, evaluator,
 * and experiments surfaces (a caller needing a curated subset filters this at its own
 * call site — see design-doc decision 4). Seeded here; the operator completes the real
 * per-region lists. Editing this constant + redeploying is how the offered set changes.
 *
 * INVARIANT: every value is a literal Bedrock/Mantle model id (no prefix token).
 */
export const SUPPORTED_MODELS: RegionKeyedModels = {
    // Seed — operator extends with the real exhaustive per-region availability.
    // A display name may map to a different literal id per region.
    "us-east-1": {
        "Claude Sonnet 4.6": "us.anthropic.claude-sonnet-4-6", // Converse, geo prefix
        "Claude Haiku 4.5": "us.anthropic.claude-haiku-4-5-20251001-v1:0", // Converse, geo prefix
        "Nova 2 Lite": "us.amazon.nova-2-lite-v1:0", // Converse, geo prefix
    },
};

/**
 * The flat display→id map for one region.
 *
 * @param region concrete AWS region (e.g. "us-east-1"); never a CDK token.
 * @returns the region's flat `Record<displayName, literalId>`.
 * @throws Error if `region` is not a key of SUPPORTED_MODELS — message lists the
 *         supported regions so the operator can correct the deploy target.
 */
export function modelsForRegion(region: string): Record<string, string> {
    const models = SUPPORTED_MODELS[region];
    if (!models) {
        throw new Error(
            `No supported models for region "${region}". ` +
                `Supported regions: ${Object.keys(SUPPORTED_MODELS).join(", ")}.`,
        );
    }
    return models;
}

/**
 * Synth-time guard. Verifies `region` is supported; throws with the supported-region
 * list otherwise. Kept separate from `modelsForRegion` so `aca.ts` can fail fast before
 * any construct is created, with a message framed for the deploy step rather than the UI.
 *
 * @param region concrete AWS region resolved from the environment (T3).
 * @throws Error if `region` is falsy (unset env) OR not in SUPPORTED_MODELS.
 */
export function assertRegionSupported(region: string | undefined): asserts region is string {
    const supported = Object.keys(SUPPORTED_MODELS).join(", ");
    if (!region) {
        throw new Error(
            `Deploy region is not set. Set CDK_DEFAULT_REGION (or AWS_REGION) to one of: ${supported}.`,
        );
    }
    if (!(region in SUPPORTED_MODELS)) {
        throw new Error(
            `Deploy region "${region}" has no supported models. ` +
                `Deploy to one of: ${supported}.`,
        );
    }
}
