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

export const STEP_MIN_HEIGHT = "62vh";

// ---------------------------------------------------------------------------
// Reasoning budget helpers — keep in sync with backend _INT_BUDGET_MODELS /
// _EFFORT_BUDGET_MODELS in stream_types.py
// ---------------------------------------------------------------------------

/** Models that require an integer reasoning budget (minimum 1024 tokens) */
export const INT_BUDGET_MODEL_FRAGMENTS = [
    "claude-opus-4-5",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-7-sonnet",
];

/** Models that require a ReasoningEffort enum value (low / medium / high) */
export const EFFORT_BUDGET_MODEL_FRAGMENTS = [
    "nova-2-lite",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
];

export const REASONING_EFFORT_OPTIONS = [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
];

/**
 * Determine what kind of reasoning budget a model supports.
 * Returns "int" for token-budget models, "effort" for low/medium/high models,
 * or null if the model does not support reasoning.
 */
export function getReasoningType(modelId: string): "int" | "effort" | null {
    // Check effort models FIRST — their fragments are more specific
    // (e.g., "claude-opus-4-6" would otherwise match the broader "claude-opus-4")
    if (EFFORT_BUDGET_MODEL_FRAGMENTS.some((frag) => modelId.includes(frag))) return "effort";
    if (INT_BUDGET_MODEL_FRAGMENTS.some((frag) => modelId.includes(frag))) return "int";
    return null;
}
