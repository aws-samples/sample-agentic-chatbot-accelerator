// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    ChatBotAction,
    ChatBotHistoryItem,
    ChatBotMessageResponse,
    ChatBotMessageType,
    LLMToken,
    ToolActionItem,
    ToolParameter,
} from "./types";

// Tokens that should stay fully upper-cased when humanizing a tool name.
// Extend as new acronyms show up in tool names.
const TOOL_NAME_ACRONYMS = new Set(["aws", "s3", "api", "a2a"]);

/**
 * Resolve the concrete runtime version for a selected endpoint (qualifier).
 *
 * `listRuntimeAgents` returns `qualifierToVersion` as a JSON string mapping each
 * endpoint name to its numeric AgentCore version. The container persists this
 * value to session history so the Sessions table can show which version served
 * a conversation. Returns "" when the map is missing/unparseable or the
 * qualifier has no entry, matching the read-side fallback.
 */
export function resolveRuntimeVersion(
    qualifierToVersion: string | null | undefined,
    qualifier: string,
): string {
    if (!qualifierToVersion) return "";
    try {
        const version = (JSON.parse(qualifierToVersion) as Record<string, number | string>)[qualifier];
        return version === undefined || version === null ? "" : String(version);
    } catch {
        return "";
    }
}

/**
 * Turn a raw tool name into a human-friendly label.
 *
 * Tool names arrive as identifiers (e.g. `search_documentation`) and MCP tools
 * are namespaced by their server with a `prefix___tool` separator (Strands).
 * We drop the server prefix, then convert separators to spaces and Title Case
 * each word so the step reads as a short action ("Search Documentation").
 * Known acronyms (see TOOL_NAME_ACRONYMS) render fully upper-cased.
 *
 * The raw spec description is intentionally NOT used as the label: MCP tools
 * pack their entire prompt-engineering blob into the description, which floods
 * the UI. The tool name is bounded and reliable. See cache/specs/tool-steps.
 */
export function humanizeToolName(toolName: string): string {
    if (!toolName) return "tool";
    // Drop the MCP server prefix ("server___tool" → "tool"); keep the last segment.
    const bare = toolName.split("___").pop() ?? toolName;
    const words = bare
        .replace(/[_-]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return toolName;
    return words
        .map((w) =>
            TOOL_NAME_ACRONYMS.has(w.toLowerCase())
                ? w.toUpperCase()
                : w.charAt(0).toUpperCase() + w.slice(1),
        )
        .join(" ");
}

// Replacement token shown to the user in place of account-identifying info.
const MASK = "MASKED";

/**
 * Redact AWS account IDs and region codes from a string for display.
 *
 * This is a UI-only transform — it never mutates the underlying value, which is
 * still carried on the WebSocket payload and persisted verbatim. It only changes
 * what the user sees in tool-step argument values.
 *
 * Handles values where the identifiers are embedded in (possibly URL-encoded)
 * ARNs/URLs, e.g. ".../bedrock-agentcore%3Aus-east-1%3A303326394913%3Aruntime...",
 * so it cannot rely on word boundaries (a preceding "%3A" ends in a letter).
 *
 * - Account IDs: standalone 12-digit numbers (not part of a longer digit run).
 * - Regions: real AWS region codes like us-east-1, ap-southeast-2,
 *   us-gov-west-1 — a known geo prefix, an optional "-gov", a compass segment,
 *   and a digit. Anchoring to the known prefix/compass set avoids masking
 *   unrelated dash-digit tokens (e.g. "to-do-1", "created-at-1").
 */
const AWS_REGION_RE =
    /(?<![a-z])(?:us|eu|ap|sa|ca|me|af|il|mx|cn)(?:-gov)?-(?:central|north|south|east|west|northeast|northwest|southeast|southwest)-\d(?!\d)/g;

export function maskSensitiveInfo(value: string): string {
    if (!value) return value;
    return value.replace(/(?<!\d)\d{12}(?!\d)/g, MASK).replace(AWS_REGION_RE, MASK);
}

/**
 * Attach a tool action to the most recent AI message, deduped by
 * invocationNumber and sorted. Mirrors the routing in updateMessageHistoryRef's
 * ToolAction branch, but operates directly on the message's own toolActions
 * array so it can be driven from the direct WebSocket (no index-keyed
 * accumulator needed). New steps start in the "running" state.
 *
 * The step label is derived by humanizing `toolName` (see humanizeToolName);
 * the WS payload's `description` is intentionally not used (MCP tools pack a
 * huge prompt blob into it). Argument name/value pairs are stored for display.
 *
 * Returns true if the history was mutated (caller should re-render).
 */
export function appendToolAction(
    messageHistory: ChatBotHistoryItem[],
    toolName: string,
    invocationNumber: number,
    parameters?: ToolParameter[],
): boolean {
    if (
        messageHistory.length === 0 ||
        messageHistory[messageHistory.length - 1]?.type === ChatBotMessageType.Human
    ) {
        return false;
    }

    const lastMessage = messageHistory[messageHistory.length - 1];
    const actions = lastMessage.toolActions ? [...lastMessage.toolActions] : [];

    // Dedup by invocationNumber — guards against the same step being delivered
    // more than once over the WebSocket.
    if (actions.some((ta) => ta.invocationNumber === invocationNumber)) {
        return false;
    }

    actions.push({
        toolAction: humanizeToolName(toolName),
        toolName,
        invocationNumber,
        parameters,
        status: "running",
    });
    actions.sort((a, b) => a.invocationNumber - b.invocationNumber);

    messageHistory[messageHistory.length - 1] = {
        ...lastMessage,
        toolActions: actions,
    };
    return true;
}

/**
 * Mark the tool action with the matching invocationNumber on the most recent AI
 * message as terminal ("success"/"error"). No-op if the step isn't found (its
 * tool_action may not have arrived yet). Returns true if the history mutated.
 */
export function markToolComplete(
    messageHistory: ChatBotHistoryItem[],
    invocationNumber: number,
    status: "success" | "error",
): boolean {
    if (messageHistory.length === 0) return false;

    const lastMessage = messageHistory[messageHistory.length - 1];
    if (lastMessage.type === ChatBotMessageType.Human || !lastMessage.toolActions) {
        return false;
    }

    const idx = lastMessage.toolActions.findIndex((ta) => ta.invocationNumber === invocationNumber);
    if (idx === -1) return false;

    const actions = [...lastMessage.toolActions];
    actions[idx] = { ...actions[idx], status };

    messageHistory[messageHistory.length - 1] = {
        ...lastMessage,
        toolActions: actions,
    };
    return true;
}

export function updateMessageHistoryRef(
    sessionId: string,
    messageHistory: ChatBotHistoryItem[],
    response: ChatBotMessageResponse,
    messageTokens: { [key: string]: LLMToken[] },
    toolActions: { [key: string]: ToolActionItem[] } = {},
) {
    if (response.data.sessionId !== sessionId) return;

    // Handle tool action messages
    if (response.action === ChatBotAction.ToolAction) {
        if (
            messageHistory.length > 0 &&
            messageHistory[messageHistory.length - 1]?.type !== ChatBotMessageType.Human
        ) {
            const lastMessageId = messageHistory.length - 1;
            const lastMessage = messageHistory[lastMessageId];

            // Initialize tool actions array if needed
            if (toolActions[lastMessageId] === undefined) {
                toolActions[lastMessageId] = [];
            }

            // Add tool action if we have the data
            if (
                response.data.toolAction &&
                response.data.toolName !== undefined &&
                response.data.invocationNumber !== undefined
            ) {
                // Check if this invocation number already exists (avoid duplicates)
                const exists = toolActions[lastMessageId].some(
                    (ta) => ta.invocationNumber === response.data.invocationNumber,
                );
                if (!exists) {
                    toolActions[lastMessageId].push({
                        toolAction: response.data.toolAction,
                        toolName: response.data.toolName,
                        invocationNumber: response.data.invocationNumber,
                    });
                    // Sort by invocation number
                    toolActions[lastMessageId].sort(
                        (a, b) => a.invocationNumber - b.invocationNumber,
                    );
                }
            }

            messageHistory[messageHistory.length - 1] = {
                ...lastMessage,
                toolActions: toolActions[lastMessageId],
            };
        }
        return;
    }

    if (
        response.action === ChatBotAction.FinalResponse ||
        response.action === ChatBotAction.LLMNewToken ||
        response.action === ChatBotAction.Error
    ) {
        const content = response.data?.content;
        const token = response.data?.token;
        const references = response.data?.references;
        const reasoningContent = response.data?.reasoningContent;
        const structuredOutput = response.data?.structuredOutput;
        const hasContent = typeof content !== "undefined";
        const hasToken = typeof token !== "undefined";

        if (
            messageHistory.length > 0 &&
            messageHistory[messageHistory.length - 1]?.type !== ChatBotMessageType.Human
        ) {
            const lastMessageId = messageHistory.length - 1;
            const lastMessage = messageHistory[lastMessageId];
            lastMessage.complete =
                lastMessage.complete || response.action === ChatBotAction.FinalResponse;

            // Initialize token arrays
            if (messageTokens[lastMessageId] === undefined) {
                messageTokens[lastMessageId] = [];
            }

            // Add token to array
            if (hasToken) {
                messageTokens[lastMessageId].push(token);
            }

            // Sort and filter tokens
            lastMessage.tokens = messageTokens[lastMessageId].sort(
                (a, b) => a.sequenceNumber - b.sequenceNumber,
            );

            // Filter by latest runId
            if (lastMessage.tokens.length > 0) {
                const lastRunId = lastMessage.tokens[lastMessage.tokens.length - 1].runId;
                if (lastRunId) {
                    lastMessage.tokens = lastMessage.tokens.filter((t) => t.runId === lastRunId);
                }
            }

            messageHistory[messageHistory.length - 1] = {
                ...lastMessage,
                type: ChatBotMessageType.AI,
                content: hasContent ? content : lastMessage.content,
                references: references ?? lastMessage.references,
                tokens: lastMessage.tokens,
                toolActions: toolActions[lastMessageId] ?? lastMessage.toolActions,
                reasoningContent: reasoningContent ?? lastMessage.reasoningContent,
                structuredOutput: structuredOutput ?? lastMessage.structuredOutput,
            };
        }
    }
}
