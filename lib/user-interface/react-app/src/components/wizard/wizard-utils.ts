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
