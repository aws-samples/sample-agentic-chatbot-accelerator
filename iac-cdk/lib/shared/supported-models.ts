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
 *
 * DELIBERATE OMISSION — `xai.grok-4.3`: served on Mantle and otherwise working,
 * but its tool-calling is incompatible with the Strands streaming contract. xAI
 * returns tool calls as a *complete* response and expects a fresh API call
 * carrying the results, whereas Strands pauses a single stream and resumes it in
 * place (strands-agents/harness-sdk#1340). The tool executes, the stream never
 * resumes, and the caller sees a read timeout rather than an error. Since every
 * agent here is tool-capable, offering it would surface as a hang. Re-add once
 * that issue lands.
 */
export const SUPPORTED_MODELS: RegionKeyedModels = {
    // N. Virginia
    "us-east-1": {
        // OpenAI
        "GPT-5.6 Luna": "openai.gpt-5.6-luna",
        "GPT-5.6 Sol": "openai.gpt-5.6-sol",
        "GPT-5.6 Terra": "openai.gpt-5.6-terra",
        "GPT-5.5": "openai.gpt-5.5",
        "GPT-5.4": "openai.gpt-5.4",
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Anthropic
        "Claude Sonnet 5": "anthropic.claude-sonnet-5",
        "Claude Opus 4.8": "anthropic.claude-opus-4-8",
        // Amazon
        "Nova 2 Lite": "us.amazon.nova-2-lite-v1:0",
        "Nova 2 Sonic": "amazon.nova-2-sonic-v1:0",
        // Deepseek
        "DeepSeek V3.2": "deepseek.v3.2",
        // Google
        "Gemma 4 31B": "google.gemma-4-31b",
        "Gemma 4 E2B": "google.gemma-4-e2b",
        "Gemma 4 26B-A4B": "google.gemma-4-26b-a4b",
        "Gemma 3 4B IT": "google.gemma-3-4b-it",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Mistral Large 3": "mistral.mistral-large-3-675b-instruct",
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Moonshot AI
        "Kimi K2.5": "moonshotai.kimi-k2.5",
        // nVIDIA
        "NVIDIA Nemotron 3 Super 120B": "nvidia.nemotron-super-3-120b",
        // Qwen
        "Qwen3 Next 80B A3B": "qwen.qwen3-next-80b-a3b-instruct",
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 5": "zai.glm-5",
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // Ohio
    "us-east-2": {
        // OpenAI
        "GPT-5.6 Luna": "openai.gpt-5.6-luna",
        "GPT-5.6 Sol": "openai.gpt-5.6-sol",
        "GPT-5.6 Terra": "openai.gpt-5.6-terra",
        "GPT-5.5": "openai.gpt-5.5",
        "GPT-5.4": "openai.gpt-5.4",
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Amazon
        "Nova 2 Lite": "us.amazon.nova-2-lite-v1:0",
        // Deepseek
        "DeepSeek V3.2": "deepseek.v3.2",
        // Google
        "Gemma 4 31B": "google.gemma-4-31b",
        "Gemma 4 E2B": "google.gemma-4-e2b",
        "Gemma 4 26B-A4B": "google.gemma-4-26b-a4b",
        "Gemma 3 4B IT": "google.gemma-3-4b-it",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Mistral Large 3": "mistral.mistral-large-3-675b-instruct",
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Moonshot AI
        "Kimi K2.5": "moonshotai.kimi-k2.5",
        // nVIDIA
        "NVIDIA Nemotron 3 Super 120B": "nvidia.nemotron-super-3-120b",
        // Qwen
        "Qwen3 Next 80B A3B": "qwen.qwen3-next-80b-a3b-instruct",
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 5": "zai.glm-5",
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // Oregon
    "us-west-2": {
        // OpenAI
        "GPT-5.6 Luna": "openai.gpt-5.6-luna",
        "GPT-5.6 Terra": "openai.gpt-5.6-terra",
        "GPT-5.4": "openai.gpt-5.4",
        "GPT OSS Safeguard 20B": "openai.gpt-oss-safeguard-20b",
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Amazon
        "Nova 2 Lite": "us.amazon.nova-2-lite-v1:0",
        "Nova 2 Sonic": "amazon.nova-2-sonic-v1:0",
        // Deepseek
        "DeepSeek V3.2": "deepseek.v3.2",
        // Google
        "Gemma 4 31B": "google.gemma-4-31b",
        "Gemma 4 E2B": "google.gemma-4-e2b",
        "Gemma 4 26B-A4B": "google.gemma-4-26b-a4b",
        "Gemma 3 4B IT": "google.gemma-3-4b-it",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Mistral Large 3": "mistral.mistral-large-3-675b-instruct",
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Moonshot AI
        "Kimi K2.5": "moonshotai.kimi-k2.5",
        // nVIDIA
        "NVIDIA Nemotron 3 Super 120B": "nvidia.nemotron-super-3-120b",
        // Qwen
        "Qwen3 Next 80B A3B": "qwen.qwen3-next-80b-a3b-instruct",
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 5": "zai.glm-5",
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // Frankfurt
    "eu-central-1": {
        // OpenAI
        "GPT OSS Safeguard 20B": "openai.gpt-oss-safeguard-20b",
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Amazon
        "Nova 2 Lite": "eu.amazon.nova-2-lite-v1:0",
        // Google
        "Gemma 4 31B": "google.gemma-4-31b",
        "Gemma 4 E2B": "google.gemma-4-e2b",
        "Gemma 4 26B-A4B": "google.gemma-4-26b-a4b",
        "Gemma 3 4B IT": "google.gemma-3-4b-it",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Qwen
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // Stockholm
    "eu-north-1": {
        // OpenAI
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Anthropic
        "Claude Opus 4.8": "anthropic.claude-opus-4-8",
        // Amazon
        "Nova 2 Lite": "eu.amazon.nova-2-lite-v1:0",
        "Nova 2 Sonic": "amazon.nova-2-sonic-v1:0",
        // Deepseek
        "DeepSeek V3.2": "deepseek.v3.2",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Mistral Large 3": "mistral.mistral-large-3-675b-instruct",
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Moonshot AI
        "Kimi K2.5": "moonshotai.kimi-k2.5",
        // Qwen
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 5": "zai.glm-5",
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // Ireland
    "eu-west-1": {
        // OpenAI
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Anthropic
        "Claude Sonnet 5": "anthropic.claude-sonnet-5",
        "Claude Opus 4.8": "anthropic.claude-opus-4-8",
        // Amazon
        "Nova 2 Lite": "eu.amazon.nova-2-lite-v1:0",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // nVIDIA
        "NVIDIA Nemotron 3 Super 120B": "nvidia.nemotron-super-3-120b",
        // Qwen
        "Qwen3 Next 80B A3B": "qwen.qwen3-next-80b-a3b-instruct",
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
    },
    // London
    "eu-west-2": {
        // OpenAI
        "GPT OSS 20B": "openai.gpt-oss-20b",
        "GPT OSS 120B": "openai.gpt-oss-120b",
        // Amazon
        "Nova 2 Lite": "eu.amazon.nova-2-lite-v1:0",
        // Deepseek
        "DeepSeek V3.2": "deepseek.v3.2",
        // MiniMax
        "MiniMax M2.5": "minimax.minimax-m2.5",
        // Mistral
        "Mistral Large 3": "mistral.mistral-large-3-675b-instruct",
        "Ministral 14B 3.0": "mistral.ministral-3-14b-instruct",
        "Ministral 3 8B": "mistral.ministral-3-8b-instruct",
        "Ministral 3B": "mistral.ministral-3-3b-instruct",
        // Moonshot AI
        "Kimi K2.5": "moonshotai.kimi-k2.5",
        // nVIDIA
        "NVIDIA Nemotron 3 Super 120B": "nvidia.nemotron-super-3-120b",
        // Qwen
        "Qwen3 Next 80B A3B": "qwen.qwen3-next-80b-a3b-instruct",
        "Qwen3 32B": "qwen.qwen3-32b",
        "Qwen3 235B A22B 2507": "qwen.qwen3-235b-a22b-2507",
        // Z.AI
        "GLM 5": "zai.glm-5",
        "GLM 4.7 Flash": "zai.glm-4.7-flash",
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
