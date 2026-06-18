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
} from "./types";

/**
 * Attach a tool action to the most recent AI message, deduped by
 * invocationNumber and sorted. Mirrors the routing in updateMessageHistoryRef's
 * ToolAction branch, but operates directly on the message's own toolActions
 * array so it can be driven from the direct WebSocket (no index-keyed
 * accumulator needed). New steps start in the "running" state.
 *
 * Falls back to `Using {toolName}` when the description is empty — common for
 * MCP/custom tools whose static spec description is blank.
 *
 * Returns true if the history was mutated (caller should re-render).
 */
export function appendToolAction(
    messageHistory: ChatBotHistoryItem[],
    toolName: string,
    description: string,
    invocationNumber: number,
): boolean {
    if (
        messageHistory.length === 0 ||
        messageHistory[messageHistory.length - 1]?.type === ChatBotMessageType.Human
    ) {
        return false;
    }

    const lastMessage = messageHistory[messageHistory.length - 1];
    const actions = lastMessage.toolActions ? [...lastMessage.toolActions] : [];

    // Dedup by invocationNumber (the WS and AppSync paths can both deliver the
    // same step while both channels are live).
    if (actions.some((ta) => ta.invocationNumber === invocationNumber)) {
        return false;
    }

    actions.push({
        toolAction: description?.trim() || `Using ${toolName}`,
        toolName,
        invocationNumber,
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
