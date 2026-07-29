// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

// Set of dangerous keys that could lead to prototype pollution
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Helper function to check for prototype pollution attacks
const isSafePropertyKey = (key: string): boolean => {
    return !DANGEROUS_KEYS.has(key);
};

// Safe deep property setter that prevents prototype pollution using recursion
const safeDeepSetRecursive = (
    obj: Record<string, any>,
    keys: readonly string[],
    keyIndex: number,
    value: any,
): Record<string, any> => {
    if (keyIndex === keys.length - 1) {
        const finalKey = keys[keyIndex];
        return { ...obj, [finalKey]: value };
    }

    const currentKey = keys[keyIndex];
    const currentValue = Object.prototype.hasOwnProperty.call(obj, currentKey)
        ? obj[currentKey]
        : null;
    const nestedObj =
        typeof currentValue === "object" && currentValue !== null
            ? currentValue
            : Object.create(null);

    return {
        ...obj,
        [currentKey]: safeDeepSetRecursive(nestedObj, keys, keyIndex + 1, value),
    };
};

/** Safe deep property setter that prevents prototype pollution */
export const safeDeepSet = <T extends Record<string, any>>(obj: T, path: string, value: any): T => {
    const keys = path.split(".");

    if (!keys.every(isSafePropertyKey)) {
        console.error("Invalid property path detected - potential prototype pollution");
        return obj;
    }

    return safeDeepSetRecursive(obj, keys, 0, value) as T;
};

export { DANGEROUS_KEYS };

export const CONVERSATION_MANAGER_OPTIONS = [
    { label: "Sliding Window", value: "sliding_window" },
    { label: "Summarizing", value: "summarizing" },
    { label: "None", value: "null" },
];

/** Supported Python types for structured output fields */
export const PYTHON_TYPE_OPTIONS = [
    { label: "str", value: "str" },
    { label: "int", value: "int" },
    { label: "float", value: "float" },
    { label: "bool", value: "bool" },
    { label: "list[str]", value: "list[str]" },
    { label: "list[int]", value: "list[int]" },
    { label: "list[float]", value: "list[float]" },
    { label: "dict", value: "dict" },
];

export const STEP_MIN_HEIGHT = "62vh";

// ---------------------------------------------------------------------------
// Model provider grouping — for rendering the model <Select> with one group per
// provider. The provider is derived from the model id, which is the only signal
// available: aws-exports.json carries a flat display→id map (see
// iac-cdk/lib/shared/supported-models.ts), not provider metadata.
// ---------------------------------------------------------------------------

/** Model id prefix → provider display name, in the order groups should appear. */
const MODEL_PROVIDER_LABELS: [prefix: string, label: string][] = [
    ["anthropic", "Anthropic"],
    ["openai", "OpenAI"],
    ["amazon", "Amazon"],
    ["deepseek", "DeepSeek"],
    ["google", "Google"],
    ["minimax", "MiniMax"],
    ["mistral", "Mistral"],
    ["moonshotai", "Moonshot AI"],
    ["nvidia", "NVIDIA"],
    ["qwen", "Qwen"],
    ["xai", "xAI"],
    ["zai", "Z.AI"],
];

/**
 * Provider display name for a model id. Strips a Bedrock cross-region geo prefix
 * (`us.` / `eu.` / `apac.`) first, so `us.amazon.nova-2-lite-v1:0` and
 * `amazon.nova-2-sonic-v1:0` both resolve to "Amazon".
 *
 * Returns "Other" for an unrecognized prefix so a newly added provider still
 * renders (in a trailing group) instead of disappearing from the dropdown.
 */
export function getModelProvider(modelId: string): string {
    const withoutGeo = modelId.replace(/^(us|eu|apac)\./, "");
    const vendor = withoutGeo.split(".")[0]?.toLowerCase() ?? "";
    return MODEL_PROVIDER_LABELS.find(([prefix]) => prefix === vendor)?.[1] ?? "Other";
}

/**
 * Group flat model options into Cloudscape `<Select>` option groups, one per
 * provider. Groups follow MODEL_PROVIDER_LABELS order (with "Other" last); the
 * options inside each group keep their incoming order.
 *
 * The flat list is still what callers should use for `selectedOption` lookups —
 * this only shapes the `options` prop.
 */
export function groupModelOptionsByProvider(
    modelOptions: { label: string; value: string }[],
): { label: string; options: { label: string; value: string }[] }[] {
    const groupOrder = [...MODEL_PROVIDER_LABELS.map(([, label]) => label), "Other"];
    const byProvider = new Map<string, { label: string; value: string }[]>();

    for (const option of modelOptions) {
        const provider = getModelProvider(option.value);
        const group = byProvider.get(provider);
        if (group) {
            group.push(option);
        } else {
            byProvider.set(provider, [option]);
        }
    }

    return groupOrder
        .filter((provider) => byProvider.has(provider))
        .map((provider) => ({ label: provider, options: byProvider.get(provider)! }));
}

// ---------------------------------------------------------------------------
// Reasoning budget helpers — keep in sync with backend _EFFORT_BUDGET_MODELS in
// stream_types.py. Reasoning is expressed as an effort level (low/medium/high);
// integer token budgets are no longer supported.
// ---------------------------------------------------------------------------

/** Models that support a ReasoningEffort enum value (low / medium / high) */
export const EFFORT_BUDGET_MODEL_FRAGMENTS = [
    "nova-2-lite",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-5",
    "claude-sonnet-5",
];

export const REASONING_EFFORT_OPTIONS = [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
];

/**
 * Determine whether a model supports reasoning.
 * Returns "effort" for low/medium/high models, or null if the model does not
 * support reasoning.
 */
export function getReasoningType(modelId: string): "effort" | null {
    if (EFFORT_BUDGET_MODEL_FRAGMENTS.some((frag) => modelId.includes(frag))) return "effort";
    return null;
}
