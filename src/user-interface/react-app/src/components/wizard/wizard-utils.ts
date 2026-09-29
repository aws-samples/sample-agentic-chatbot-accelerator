// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { WizardProps } from "@cloudscape-design/components";
import { Dispatch, SetStateAction } from "react";
import { AgentCoreRuntimeConfiguration, GraphOrchestratorConfig } from "./types";

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
// Reasoning capability mirror.
//
// Reasoning is expressed as an effort level; integer token budgets are no longer
// supported. Which levels a model accepts differs per family — xhigh/max are
// Opus-only, GPT-5.6 documents all six, Sonnet 5 cannot turn reasoning off at
// all — so this is a per-model table rather than a membership list.
//
// MAINTENANCE: hand-mirrored from REASONING_CAPABILITIES in
// src/agent-core/shared/stream_types.py, which is the source of truth (derived
// from the AWS model cards; the Mantle /v1/models catalog exposes no reasoning
// metadata). The frontend cannot import Python, so
// src/agent-core/shared/tests/test_reasoning_capability.py parses THIS FILE and
// fails when the two disagree — update both in the same commit.
// ---------------------------------------------------------------------------

/**
 * Effort values a model accepts, plus whether its reasoning can be disabled.
 * Mirrors ReasoningCapability in src/agent-core/shared/stream_types.py.
 */
export interface ReasoningCapability {
    /** Accepted effort values, ordered for display: "none" first, then low → max. */
    efforts: string[];
    /** False => the model card states reasoning is always on and cannot be disabled. */
    canDisable: boolean;
    /** The effort the provider applies when the parameter is omitted, only where AWS documents it. */
    defaultEffort?: string;
    /** A card *recommendation* that is not the provider default (gemma-4-e2b). */
    recommendedEffort?: string;
}

// Ordered low → max for display. See the PROVENANCE note on the Python table
// (stream_types.py): these sets are live-verified, not doc-derived.
const EFFORT_LMH = ["low", "medium", "high"];
// Anthropic adaptive thinking — the full ladder minus `none`, which the Messages
// API rejects. Applies to Sonnet too, contra the "Opus only" docs claim.
const EFFORT_ANTHROPIC = [...EFFORT_LMH, "xhigh", "max"];
// Everything except `max`: what most OpenAI-surface families actually accept.
const EFFORT_NO_MAX = ["none", ...EFFORT_LMH, "xhigh"];
// GPT-5.6 (Sol/Terra/Luna) is the only family that accepts all six.
const EFFORT_ALL = [...EFFORT_NO_MAX, "max"];

/**
 * Model-id fragment → capability. Keyed by fragment (substring match) so one
 * entry covers a family and both the geo-prefixed and bare forms of the same id.
 * Longest fragment wins — see getReasoningCapability.
 */
export const REASONING_CAPABILITIES: Record<string, ReasoningCapability> = {
    // -- Anthropic (Messages) — adaptive thinking, `high` is the documented default
    "claude-opus-5": {
        efforts: EFFORT_ANTHROPIC,
        canDisable: true,
        defaultEffort: "high",
    },
    "claude-opus-4-8": {
        efforts: EFFORT_ANTHROPIC,
        canDisable: true,
        defaultEffort: "high",
    },
    "claude-opus-4-6": {
        efforts: EFFORT_ANTHROPIC,
        canDisable: true,
        defaultEffort: "high",
    },
    // Sonnet takes the same five levels as Opus (the "Opus only" docs claim about
    // xhigh/max is wrong). Sonnet 5's thinking is always on and cannot be
    // disabled, consistent with Messages rejecting `none`.
    "claude-sonnet-5": {
        efforts: EFFORT_ANTHROPIC,
        canDisable: false,
        defaultEffort: "high",
    },
    "claude-sonnet-4-6": {
        efforts: EFFORT_ANTHROPIC,
        canDisable: true,
        defaultEffort: "high",
    },
    // -- OpenAI proprietary (Responses). "gpt-5." is a prefix of "gpt-5.6", so
    // longest-match is what keeps `max` from leaking to 5.4/5.5, which 400 on it.
    "gpt-5.6": { efforts: EFFORT_ALL, canDisable: true },
    "gpt-5.5": { efforts: EFFORT_NO_MAX, canDisable: true },
    "gpt-5.4": { efforts: EFFORT_NO_MAX, canDisable: true },
    // -- OpenAI open-weights (Chat Completions) — genuinely three-level
    "gpt-oss": { efforts: EFFORT_LMH, canDisable: true },
    // -- Google Gemma 4 (Chat Completions) — none+xhigh undocumented but accepted
    "gemma-4-31b": { efforts: EFFORT_NO_MAX, canDisable: true },
    "gemma-4-26b-a4b": { efforts: EFFORT_NO_MAX, canDisable: true },
    // E2B over-reasons by default; the card *recommends* high. A recommendation,
    // not the provider default.
    "gemma-4-e2b": {
        efforts: EFFORT_NO_MAX,
        canDisable: true,
        recommendedEffort: "high",
    },
    // -- xAI (Chat Completions) — reasons unless explicitly set to none
    "grok-4.3": { efforts: EFFORT_NO_MAX, canDisable: true, defaultEffort: "low" },
    // -- Amazon Nova (Converse) — off by default, so no default effort to report.
    // `high` also requires maxTokens unset; the backend handles that.
    "nova-2-lite": { efforts: EFFORT_LMH, canDisable: true },
};

/** Display label per effort value. */
const REASONING_EFFORT_LABELS: Record<string, string> = {
    none: "None (disable reasoning)",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
};

/**
 * Resolve the capability for a model id, or null when it has no controllable
 * reasoning. Matches the LONGEST fragment contained in modelId so a specific
 * family entry beats a prefix of itself ("gpt-5.6" over "gpt-5.").
 */
export function getReasoningCapability(modelId: string): ReasoningCapability | null {
    const matches = Object.keys(REASONING_CAPABILITIES).filter((frag) => modelId.includes(frag));
    if (matches.length === 0) return null;
    const longest = matches.reduce((a, b) => (b.length > a.length ? b : a));
    return REASONING_CAPABILITIES[longest];
}

/**
 * Effort options for the given model, as Cloudscape select options.
 * Returns [] when the model has no reasoning — callers use that to hide the
 * control entirely rather than rendering an empty picker.
 */
export function getReasoningEffortOptions(modelId: string): { label: string; value: string }[] {
    const capability = getReasoningCapability(modelId);
    if (!capability) return [];
    return capability.efforts.map((value) => ({
        label: REASONING_EFFORT_LABELS[value] ?? value,
        value,
    }));
}

/**
 * The effort to preselect when the user first enables reasoning for a model.
 *
 * Returns the model's documented default when there is one (Claude "high",
 * Grok "low"), else its card-recommended value (gemma-4-e2b), else null —
 * meaning no defensible preselection exists and the picker must open empty
 * rather than inventing a level. AWS publishes accepted values but no default
 * for openai.gpt-5.*, gpt-oss-* and gemma-4-31b/26b.
 */
export function getDefaultReasoningEffort(modelId: string): string | null {
    const capability = getReasoningCapability(modelId);
    if (!capability) return null;
    return capability.defaultEffort ?? capability.recommendedEffort ?? null;
}

/** Whether `effort` is one of the values the model accepts. */
export function isReasoningEffortAccepted(modelId: string, effort: string): boolean {
    return getReasoningCapability(modelId)?.efforts.includes(effort) ?? false;
}

type ModelInferenceParameters = AgentCoreRuntimeConfiguration["modelInferenceParameters"];

/** AgentConfigSection's model props, bound to a config that holds `modelInferenceParameters`. */
export function bindModelParams<T extends { modelInferenceParameters: ModelInferenceParameters }>(
    params: ModelInferenceParameters,
    setConfig: Dispatch<SetStateAction<T>>,
) {
    const update = (fn: (p: ModelInferenceParameters) => ModelInferenceParameters) =>
        setConfig((prev) => ({
            ...prev,
            modelInferenceParameters: fn(prev.modelInferenceParameters),
        }));
    return {
        modelId: params.modelId,
        temperature: params.parameters.temperature,
        maxTokens: params.parameters.maxTokens,
        reasoningBudget: params.reasoningBudget,
        onModelChange: (modelId: string) =>
            update((p) => {
                // Keep the effort only if the NEW model accepts the value already
                // selected. Sharing a reasoning "type" is not enough: Opus 4.8's xhigh
                // is rejected by Sonnet 5, which documents only low/medium/high.
                const keepBudget =
                    p.reasoningBudget != null &&
                    isReasoningEffortAccepted(modelId, p.reasoningBudget);
                return { ...p, modelId, ...(keepBudget ? {} : { reasoningBudget: undefined }) };
            }),
        onTemperatureChange: (temperature: number) =>
            update((p) => ({ ...p, parameters: { ...p.parameters, temperature } })),
        onMaxTokensChange: (maxTokens: number) =>
            update((p) => ({ ...p, parameters: { ...p.parameters, maxTokens } })),
        onReasoningBudgetChange: (reasoningBudget: string | undefined) =>
            update((p) => ({ ...p, reasoningBudget })),
    };
}

// AgentCore caps runtime names at 48 characters. Only single agents get an A2A twin
// runtime named `<name>_a2a`, so their names must leave room for the suffix.
export const AGENT_NAME_MAX_LENGTH = 48;
export const SINGLE_AGENT_NAME_MAX_LENGTH = AGENT_NAME_MAX_LENGTH - "_a2a".length;

/** Validation message for an agent name, or "" when valid. */
export function agentNameError(name: string, maxLength: number): string {
    if (name.trim() === "") return "Agent name is required";
    if (!new RegExp(`^[a-zA-Z][a-zA-Z0-9_]{0,${maxLength - 1}}$`).test(name)) {
        const limit =
            maxLength < AGENT_NAME_MAX_LENGTH
                ? `max ${maxLength} characters; the A2A twin runtime appends '_a2a' and the combined name must fit AgentCore's ${AGENT_NAME_MAX_LENGTH}-char limit`
                : `max ${maxLength} characters`;
        return `Agent name must start with a letter and contain only letters, numbers, and underscores (${limit})`;
    }
    return "";
}

/** Limits shared by the swarm and graph orchestrators; swarm adds maxHandoffs. */
export const DEFAULT_ORCHESTRATOR_LIMITS: GraphOrchestratorConfig = {
    maxIterations: 50,
    executionTimeoutSeconds: 300,
    nodeTimeoutSeconds: 60,
};
export const DEFAULT_MAX_HANDOFFS = 15;

export const orchestratorTimeoutsValid = (o: GraphOrchestratorConfig): boolean =>
    o.executionTimeoutSeconds > 0 &&
    o.nodeTimeoutSeconds > 0 &&
    o.nodeTimeoutSeconds <= o.executionTimeoutSeconds;

export const wizardI18nStrings = (submitButton: string): WizardProps.I18nStrings => ({
    stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
    collapsedStepsLabel: (stepNumber, stepsCount) => `Step ${stepNumber} of ${stepsCount}`,
    navigationAriaLabel: "Steps",
    cancelButton: "Cancel",
    previousButton: "Previous",
    nextButton: "Next",
    submitButton,
});

export const KB_TOOL_PREFIX = "retrieve_from_kb_";

interface ToolSelectionConfig {
    tools?: string[];
    toolParameters?: Record<string, any>;
    mcpServers?: string[];
}

/** Add/remove handlers for the tools, knowledge bases and MCP servers of an agent config. */
export function toolSelectionActions<T extends ToolSelectionConfig>(
    config: T,
    setConfig: Dispatch<SetStateAction<T>>,
) {
    const tools = config.tools ?? [];
    const mcpServers = config.mcpServers ?? [];
    const addToolWithParameters = (toolName: string, parameters: Record<string, any>) =>
        setConfig((prev) => ({
            ...prev,
            tools: [...(prev.tools ?? []), toolName],
            toolParameters: { ...(prev.toolParameters ?? {}), [toolName]: parameters },
        }));
    return {
        addTool: (toolName: string | undefined) => {
            if (!toolName || toolName === "retrieve_from_kb" || tools.includes(toolName)) return;
            addToolWithParameters(toolName, {});
        },
        removeTool: (toolName: string) =>
            setConfig((prev) => {
                const toolParameters = { ...(prev.toolParameters ?? {}) };
                delete toolParameters[toolName];
                return {
                    ...prev,
                    tools: (prev.tools ?? []).filter((t) => t !== toolName),
                    toolParameters,
                };
            }),
        addKnowledgeBase: (kbId: string | undefined) => {
            if (!kbId) return;
            const toolName = `${KB_TOOL_PREFIX}${kbId}`;
            if (tools.includes(toolName)) return;
            addToolWithParameters(toolName, {
                retrieval_cfg: { vectorSearchConfiguration: { numberOfResults: "5" } },
                kb_id: kbId,
            });
        },
        addMcpServer: (serverName: string | undefined) => {
            if (!serverName || mcpServers.includes(serverName)) return;
            setConfig((prev) => ({
                ...prev,
                mcpServers: [...(prev.mcpServers ?? []), serverName],
            }));
        },
        removeMcpServer: (serverName: string) =>
            setConfig((prev) => ({
                ...prev,
                mcpServers: (prev.mcpServers ?? []).filter((s) => s !== serverName),
            })),
    };
}

/** Select options from an `aws-exports` model map of label → model id. */
export const toModelOptions = (
    models: Record<string, unknown> | null | undefined,
): { label: string; value: string }[] =>
    Object.entries(models ?? {}).map(([label, value]) => ({ label, value: value as string }));
