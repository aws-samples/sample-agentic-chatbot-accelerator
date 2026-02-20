import {
    ChatBotAction,
    ChatBotHistoryItem,
    ChatBotMessageResponse,
    ChatBotMessageType,
    LLMToken,
    ToolActionItem,
} from "./types";

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
            };
        }
    }
}
