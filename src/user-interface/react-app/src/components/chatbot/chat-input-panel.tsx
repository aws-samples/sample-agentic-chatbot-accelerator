// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Button, FormField, Select, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import PromptInput, { PromptInputProps } from "@cloudscape-design/components/prompt-input";
import { generateClient } from "aws-amplify/api";
import { Dispatch, SetStateAction, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";

import { fetchUserAttributes } from "aws-amplify/auth";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import { saveToolActions, updateMessageExecutionTime } from "../../graphql/mutations";

import {
    connectToAgent,
    FinalResponsePayload,
    WebSocketAgentConnection,
} from "../../websocket-presigned";

import {
    AgentOption,
    ChatBotAction,
    ChatBotHistoryItem,
    ChatBotMessageResponse,
    ChatBotMessageType,
    EndpointOption,
    LLMToken,
    ToolActionItem,
} from "./types";
import { appendToolAction, markToolComplete, resolveRuntimeVersion, updateMessageHistoryRef } from "./utils";

export interface ChatInputPanelProps {
    running: boolean;
    setRunning: Dispatch<SetStateAction<boolean>>;
    session: {
        id: string;
        loading: boolean;
        runtimeId?: string;
        endpoint?: string;
    };
    messageHistory: ChatBotHistoryItem[];
    setMessageHistory: (history: ChatBotHistoryItem[]) => void;

    // Lifted agent/endpoint state from chat.tsx
    agentRuntimeId: string;
    setAgentRuntimeId: Dispatch<SetStateAction<string>>;
    qualifier: string;
    setQualifier: Dispatch<SetStateAction<string>>;
    availableAgents: AgentOption[];
    availableEndpoints: EndpointOption[];
    agentsLoading: boolean;
    endpointsLoading: boolean;
    voiceSupported: boolean;
    refreshAgents: () => void;

    /** Called when the user clicks the voice button — passes agent info for VoiceConversationView */
    onVoiceStart?: (info: { agentRuntimeId: string; qualifier: string; agentName: string }) => void;
}

export abstract class ChatScrollState {
    static userHasScrolled = false;
    static skipNextScrollEvent = false;
    static skipNextHistoryUpdate = false;
    /** Set to true when a new message is sent; triggers scroll-to-user-message */
    static scrollToUserMessage = false;
}

/** Imperative handle exposed by ChatInputPanel via ref */
export interface ChatInputPanelHandle {
    /** Close the text WebSocket connection. Returns a promise that resolves once fully closed. */
    closeWebSocket: () => Promise<void>;
    /**
     * Re-invoke the agent with the most recent user prompt, replacing the last AI
     * response in place. No-op while a generation is in flight.
     */
    regenerateLast: () => void;
    /** Populate the prompt input without sending (T3 editable support prompts). */
    setInputValue: (value: string) => void;
}

const ChatInputPanel = forwardRef<ChatInputPanelHandle, ChatInputPanelProps>(function ChatInputPanel(props, ref) {
    const appContext = useContext(AppContext);
    const [state, setState] = useState<{ value: string }>({
        value: "",
    });
    const [readyState, setReadyState] = useState<ReadyState>(ReadyState.UNINSTANTIATED);
    // Bumped by the manual Reconnect button to force the connect effect to re-run
    // and re-establish a dropped WebSocket without reloading the page.
    const [reconnectNonce, setReconnectNonce] = useState(0);

    // Use lifted state from props
    const {
        agentRuntimeId,
        setAgentRuntimeId,
        qualifier,
        setQualifier,
        availableAgents,
        availableEndpoints,
        agentsLoading,
        endpointsLoading,
        voiceSupported,
        refreshAgents,
    } = props;

    const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);
    const wsConnectionRef = useRef<WebSocketAgentConnection | null>(null);
    const promptInputRef = useRef<PromptInputProps.Ref>(null);
    const client = generateClient();

    // Expose imperative handle so chat.tsx can close the text WS before voice mode
    // and trigger response regeneration (T4).
    useImperativeHandle(ref, () => ({
        closeWebSocket: () => {
            return new Promise<void>((resolve) => {
                if (wsConnectionRef.current) {
                    console.log(`Imperatively closing text WebSocket for session ${props.session.id}`);
                    wsConnectionRef.current.close();
                    wsConnectionRef.current = null;
                    setReadyState(ReadyState.CLOSED);
                }
                setTimeout(resolve, 200);
            });
        },
        regenerateLast: () => {
            if (props.running) return;
            if (readyState !== ReadyState.OPEN) return;
            if (!agentRuntimeId || !wsConnectionRef.current) return;

            const history = messageHistoryRef.current;
            const lastAiIdx = history.length - 1;
            if (lastAiIdx < 1 || history[lastAiIdx].type !== ChatBotMessageType.AI) return;

            // The user prompt that produced this response is the Human message just before it.
            const userMsg = history[lastAiIdx - 1];
            if (!userMsg || userMsg.type !== ChatBotMessageType.Human) return;

            // Drop the stale AI response and replay the prompt over the same path,
            // reusing the originating user prompt's messageId.
            messageHistoryRef.current = history.slice(0, lastAiIdx);
            ChatScrollState.userHasScrolled = false;
            ChatScrollState.scrollToUserMessage = true;
            void dispatchToAgent(userMsg.content, userMsg.messageId);
        },
        setInputValue: (value: string) => {
            setState((prev) => ({ ...prev, value }));
            promptInputRef.current?.focus();
        },
    }));

    useEffect(() => {
        messageHistoryRef.current = props.messageHistory;
    }, [props.messageHistory]);

    // ================================================================
    // Direct WebSocket connection to AgentCore (replaces AppSync sub)
    // ================================================================
    useEffect(() => {
        if (!agentRuntimeId || !qualifier || !appContext) return;

        // Guard against React Strict Mode double-mount: if the cleanup runs
        // before connectToAgent() resolves, we must discard the stale connection.
        let aborted = false;

        const messageTokens: { [key: string]: LLMToken[] } = {};
        const toolActions: { [key: string]: ToolActionItem[] } = {};

        setReadyState(ReadyState.CONNECTING);

        connectToAgent({
            agentRuntimeId: agentRuntimeId,
            accountId: appContext.aws_account_id,
            qualifier,
            mode: "text",
            config: {
                aws_project_region: appContext.aws_project_region,
                aws_user_pools_id: appContext.aws_user_pools_id,
                aws_cognito_identity_pool_id: appContext.aws_cognito_identity_pool_id,
            },
            sessionId: props.session.id,

            onConnected: () => {
                if (aborted) return;
                setReadyState(ReadyState.OPEN);
                console.log(`WebSocket connected for session ${props.session.id}`);
            },

            onDisconnected: () => {
                if (aborted) return;
                setReadyState(ReadyState.CLOSED);
                console.log(`WebSocket disconnected for session ${props.session.id}`);
                wsConnectionRef.current = null;
            },

            onTextToken: (data: string, sequenceNumber: number, runId?: string) => {
                if (aborted) return;
                const response: ChatBotMessageResponse = {
                    action: ChatBotAction.LLMNewToken,
                    data: {
                        sessionId: props.session.id,
                        messageId: "",
                        token: {
                            sequenceNumber,
                            value: data,
                            runId: runId || "",
                        },
                    },
                };
                updateMessageHistoryRef(
                    props.session.id,
                    messageHistoryRef.current,
                    response,
                    messageTokens,
                    toolActions,
                );
                props.setMessageHistory([...messageHistoryRef.current]);
            },

            onFinalResponse: (finalResponse: FinalResponsePayload) => {
                if (aborted) return;
                const response: ChatBotMessageResponse = {
                    action: ChatBotAction.FinalResponse,
                    data: {
                        sessionId: finalResponse.sessionId,
                        content: finalResponse.content,
                        messageId: finalResponse.messageId,
                        references: finalResponse.references,
                        reasoningContent: finalResponse.reasoningContent,
                        structuredOutput: finalResponse.structuredOutput,
                    },
                };
                updateMessageHistoryRef(
                    props.session.id,
                    messageHistoryRef.current,
                    response,
                    messageTokens,
                    toolActions,
                );
                props.setMessageHistory([...messageHistoryRef.current]);

                // Mark response as complete and save execution time
                console.log("Final message received");
                const lastMessage = messageHistoryRef.current[messageHistoryRef.current.length - 1];
                if (lastMessage && lastMessage.type === ChatBotMessageType.AI) {
                    lastMessage.complete = true;
                    if (lastMessage.startTime) {
                        lastMessage.endTime = Date.now();
                        lastMessage.executionTimeMs = lastMessage.endTime - lastMessage.startTime;
                    }

                    if (lastMessage.executionTimeMs) {
                        client
                            .graphql({
                                query: updateMessageExecutionTime,
                                variables: {
                                    sessionId: props.session.id,
                                    messageId: lastMessage.messageId,
                                    executionTimeMs: lastMessage.executionTimeMs,
                                },
                            })
                            .catch((err) =>
                                console.error("Failed to save execution time:", err),
                            );
                    }

                    // Save tool actions with a delay — the DynamoDB session record
                    // needs time to be written by the container before we can update
                    // it. Steps arrive in real time over the WebSocket, so retry
                    // while the toolActions array is still empty.
                    const saveToolActionsWithRetry = (attempt: number) => {
                        const currentMsg =
                            messageHistoryRef.current[messageHistoryRef.current.length - 1];
                        if (currentMsg?.toolActions && currentMsg.toolActions.length > 0) {
                            // Persist terminal state only: the turn is complete, so any
                            // step still "running" missed its tool_complete — coerce it
                            // to "success" rather than persisting an in-flight status.
                            const terminalActions = currentMsg.toolActions.map((ta) => ({
                                ...ta,
                                status: ta.status && ta.status !== "running" ? ta.status : "success",
                            }));
                            client
                                .graphql({
                                    query: saveToolActions,
                                    variables: {
                                        sessionId: props.session.id,
                                        messageId: currentMsg.messageId,
                                        toolActions: JSON.stringify(terminalActions),
                                    },
                                })
                                .catch((err) => {
                                    console.warn(`Save tool actions attempt ${attempt} failed:`, err);
                                    if (attempt < 3) {
                                        setTimeout(() => saveToolActionsWithRetry(attempt + 1), 3000);
                                    }
                                });
                        } else if (attempt < 3) {
                            // Tool actions haven't arrived yet — retry later
                            setTimeout(() => saveToolActionsWithRetry(attempt + 1), 3000);
                        }
                    };
                    // First attempt after 3s delay (allows the container DynamoDB write to land)
                    setTimeout(() => saveToolActionsWithRetry(1), 3000);
                }
                props.setRunning(false);
            },

            // Tool steps come directly from the AgentCore WebSocket — no LLM
            // rephrasing. Route the raw tool action into the message's toolActions
            // so it renders immediately. The label is the humanized tool name; the
            // WS `description` is ignored (MCP tools pack a huge prompt blob into it).
            // appendToolAction dedups by invocationNumber, guarding against repeated
            // WS delivery of the same step.
            onToolAction: (
                toolName: string,
                _description: string,
                invocationNumber: number,
                parameters?: { name: string; value: string }[],
            ) => {
                if (aborted) return;
                if (
                    appendToolAction(
                        messageHistoryRef.current,
                        toolName,
                        invocationNumber,
                        parameters,
                    )
                ) {
                    props.setMessageHistory([...messageHistoryRef.current]);
                }
            },

            // Mark the matching step terminal when the tool finishes.
            onToolComplete: (_toolName: string, invocationNumber: number, status: string) => {
                if (aborted) return;
                const terminal = status === "error" ? "error" : "success";
                if (markToolComplete(messageHistoryRef.current, invocationNumber, terminal)) {
                    props.setMessageHistory([...messageHistoryRef.current]);
                }
            },

            onError: (errorMessage: string) => {
                if (aborted) return;
                console.error("WebSocket error:", errorMessage);
                // Only write errors to the message history if we're actively running
                // (not during initial connection or session restore)
                if (props.running) {
                    const response: ChatBotMessageResponse = {
                        action: ChatBotAction.Error,
                        data: {
                            sessionId: props.session.id,
                            messageId: "",
                            content: `**Error**: ${errorMessage}`,
                        },
                    };
                    updateMessageHistoryRef(
                        props.session.id,
                        messageHistoryRef.current,
                        response,
                        messageTokens,
                        toolActions,
                    );
                    props.setMessageHistory([...messageHistoryRef.current]);
                    props.setRunning(false);
                }
            },
        })
            .then((conn) => {
                if (aborted) {
                    // Effect was cleaned up before the connection resolved —
                    // close the orphaned WebSocket immediately.
                    console.log(`Closing orphaned WebSocket for session ${props.session.id}`);
                    conn.close();
                    return;
                }
                wsConnectionRef.current = conn;
                console.log(`WebSocket connected to AgentCore for session ${props.session.id}`);
            })
            .catch((err) => {
                if (aborted) return;
                console.error("Failed to establish WebSocket connection:", err);
                setReadyState(ReadyState.CLOSED);
            });

        return () => {
            aborted = true;
            if (wsConnectionRef.current) {
                console.log(`Closing WebSocket for session ${props.session.id}`);
                wsConnectionRef.current.close();
                wsConnectionRef.current = null;
            }
        };
    }, [props.session.id, agentRuntimeId, qualifier, appContext, reconnectNonce]);

    // Send heartbeat when a new session is initialized (no messages yet)
    useEffect(() => {
        if (
            !wsConnectionRef.current ||
            readyState !== ReadyState.OPEN ||
            props.messageHistory.length > 0
        )
            return;

        console.log("Sending heartbeat via WebSocket");
        wsConnectionRef.current.send({ type: "heartbeat" });
    }, [readyState, props.messageHistory.length]);

    useEffect(() => {
        const onWindowScroll = () => {
            if (ChatScrollState.skipNextScrollEvent) {
                ChatScrollState.skipNextScrollEvent = false;
                return;
            }

            const isScrollToTheEnd =
                Math.abs(
                    window.innerHeight + window.scrollY - document.documentElement.scrollHeight,
                ) <= 10;

            if (!isScrollToTheEnd) {
                ChatScrollState.userHasScrolled = true;
            } else {
                ChatScrollState.userHasScrolled = false;
            }
        };

        window.addEventListener("scroll", onWindowScroll);

        return () => {
            window.removeEventListener("scroll", onWindowScroll);
        };
    }, []);

    // NOTE: Window-level auto-scroll on messageHistory change has been removed.
    // Scroll management is now handled entirely by the container-level logic in chat.tsx.
    useLayoutEffect(() => {
        if (ChatScrollState.skipNextHistoryUpdate) {
            ChatScrollState.skipNextHistoryUpdate = false;
            return;
        }
        // No auto-scroll during streaming — handled by chat.tsx container scroll
    }, [props.messageHistory]);

    const generateMessageId = (messageNumber: number): string => {
        const uuid = crypto.randomUUID();
        return `msg-${messageNumber}-${uuid}`;
    };

    // ================================================================
    // Send message via direct WebSocket (replaces AppSync sendQuery)
    // ================================================================

    /**
     * Append a fresh AI placeholder to the (already-updated) history and invoke the
     * agent with `value`. Shared by first-time sends and regeneration (T4) — the
     * caller is responsible for the preceding Human message and any history slicing.
     */
    const dispatchToAgent = async (value: string, messageId: string): Promise<void> => {
        if (!wsConnectionRef.current) return;

        const message_id = messageId;
        props.setRunning(true);
        const startTime = Date.now();
        messageHistoryRef.current = [
            ...messageHistoryRef.current,
            {
                type: ChatBotMessageType.AI,
                messageId: message_id,
                content: "",
                startTime: startTime,
            },
        ];
        props.setMessageHistory(messageHistoryRef.current);

        try {
            // Get Cognito user ID (sub) for session history persistence
            let userId = "";
            try {
                const attrs = await fetchUserAttributes();
                userId = attrs.sub || "";
            } catch {
                console.warn("Could not fetch user attributes for userId");
            }

            // Resolve the concrete runtime version for the selected endpoint so
            // the container can persist it to session history (Sessions table).
            const selectedAgent = availableAgents.find((a) => a.value === agentRuntimeId);
            const runtimeVersion = resolveRuntimeVersion(selectedAgent?.qualifierToVersion, qualifier);

            wsConnectionRef.current.send({
                type: "text_input",
                text: value,
                sessionId: props.session.id,
                userId,
                messageId: message_id,
                agentRuntimeId: agentRuntimeId,
                qualifier: qualifier,
                runtimeVersion: runtimeVersion,
            });
        } catch (err) {
            console.log(Utils.getErrorMessage(err));
            props.setRunning(false);
            messageHistoryRef.current[messageHistoryRef.current.length - 1].content =
                "**Error**, Unable to process the request: " + Utils.getErrorMessage(err);
            props.setMessageHistory(messageHistoryRef.current);
        }
    };

    const handleSendMessage = async (value: string): Promise<void> => {
        if (props.running) return;
        if (readyState !== ReadyState.OPEN) return;
        if (!agentRuntimeId) return;
        if (!wsConnectionRef.current) return;

        ChatScrollState.userHasScrolled = false;
        ChatScrollState.scrollToUserMessage = true;

        const message_id = generateMessageId(messageHistoryRef.current.length);

        setState((state) => ({
            ...state,
            value: "",
        }));

        messageHistoryRef.current = [
            ...messageHistoryRef.current,
            {
                type: ChatBotMessageType.Human,
                messageId: message_id,
                content: value,
            },
        ];
        await dispatchToAgent(value, message_id);
    };

    const isSelectedAgentReady = () => {
        if (!agentRuntimeId) return false;
        const selectedAgent = availableAgents.find((agent) => agent.value === agentRuntimeId);
        return selectedAgent?.iconName === "status-positive";
    };

    const connectionStatus = (): {
        type: "loading" | "success" | "error" | "stopped";
        label: string;
    } => {
        switch (readyState) {
            case ReadyState.CONNECTING:
                return { type: "loading", label: "Connecting…" };
            case ReadyState.OPEN:
                return { type: "success", label: "Ready" };
            case ReadyState.CLOSING:
            case ReadyState.CLOSED:
                return { type: "error", label: "Disconnected" };
            case ReadyState.UNINSTANTIATED:
            default:
                return { type: "stopped", label: "Not connected" };
        }
    };

    const wsReady = readyState === ReadyState.OPEN;
    const wsDisconnected =
        readyState === ReadyState.CLOSED || readyState === ReadyState.CLOSING;

    // Tear down any lingering socket and re-run the connect effect so a dropped
    // connection can be re-established in place (no full page reload needed).
    const reconnect = () => {
        if (wsConnectionRef.current) {
            wsConnectionRef.current.close();
            wsConnectionRef.current = null;
        }
        setReconnectNonce((n) => n + 1);
    };

    return (
        <SpaceBetween direction="vertical" size="l">
            <PromptInput
                ref={promptInputRef}
                autoFocus
                onChange={({ detail }) => {
                    setState((state) => ({
                        ...state,
                        value: detail.value,
                    }));
                }}
                spellcheck={true}
                maxRows={6}
                minRows={1}
                onAction={() => {
                    if (state.value.trim() !== "") {
                        handleSendMessage(state.value.trim());
                    }
                }}
                value={state.value}
                actionButtonIconName="send"
                placeholder="Ask a question"
                ariaLabel={
                    props.running || !agentRuntimeId ? "Prompt input - suppressed" : "Prompt input"
                }
                actionButtonAriaLabel={
                    props.running || !agentRuntimeId
                        ? "Send message button - suppressed"
                        : "Send message"
                }
                disableActionButton={state.value.trim() === ""}
                disabled={props.running || !agentRuntimeId || !isSelectedAgentReady() || !wsReady}
            />

            <SpaceBetween direction="vertical" size="s" alignItems="end">
                <SpaceBetween direction="horizontal" size="s" alignItems="end">
                    {!agentsLoading && availableAgents.length > 0 && (
                        <>
                            <div style={{ width: "200px" }}>
                                <FormField label="Agent Runtime">
                                    <Select
                                        disabled={
                                            props.running ||
                                            props.messageHistory.length > 0 ||
                                            agentsLoading
                                        }
                                        placeholder={
                                            agentsLoading
                                                ? "Loading agents..."
                                                : "Select agent runtime"
                                        }
                                        selectedOption={
                                            agentRuntimeId
                                                ? availableAgents.find(
                                                      (a) => a.value === agentRuntimeId,
                                                  ) || null
                                                : null
                                        }
                                        onChange={({ detail }) =>
                                            setAgentRuntimeId(detail.selectedOption?.value || "")
                                        }
                                        options={availableAgents}
                                        statusType={agentsLoading ? "loading" : "finished"}
                                        loadingText="Loading agents..."
                                    />
                                </FormField>
                            </div>

                            <div style={{ width: "200px" }}>
                                <FormField label="Endpoint">
                                    <Select
                                        disabled={
                                            props.running ||
                                            props.messageHistory.length > 0 ||
                                            !agentRuntimeId ||
                                            endpointsLoading
                                        }
                                        placeholder={
                                            endpointsLoading
                                                ? "Loading endpoints..."
                                                : "Select endpoint"
                                        }
                                        selectedOption={
                                            qualifier
                                                ? availableEndpoints.find(
                                                      (e) => e.value === qualifier,
                                                  ) || null
                                                : null
                                        }
                                        onChange={({ detail }) =>
                                            setQualifier(detail.selectedOption?.value || "DEFAULT")
                                        }
                                        options={availableEndpoints}
                                        statusType={endpointsLoading ? "loading" : "finished"}
                                        loadingText="Loading endpoints..."
                                    />
                                </FormField>
                            </div>
                            {/* Match the Select input height (32px) so these
                                unlabeled controls center on the boxes rather than
                                bottom-hugging the taller labeled FormField columns. */}
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    height: "32px",
                                }}
                            >
                                <Button
                                    iconName="refresh"
                                    variant="icon"
                                    onClick={refreshAgents}
                                    disabled={agentsLoading}
                                />
                                <StatusIndicator type={connectionStatus().type}>
                                    {connectionStatus().label}
                                </StatusIndicator>
                                {wsDisconnected && agentRuntimeId && qualifier && (
                                    <Button iconName="refresh" onClick={reconnect}>
                                        Reconnect
                                    </Button>
                                )}
                            </div>
                        </>
                    )}
                </SpaceBetween>
                {/* Voice mode — available for Single Agent and Agents-as-Tools with Nova Sonic */}
                {voiceSupported && agentRuntimeId && isSelectedAgentReady() && props.onVoiceStart && (
                    <Button
                        iconName="microphone"
                        onClick={() => {
                            const selectedAgent = availableAgents.find((a) => a.value === agentRuntimeId);
                            props.onVoiceStart!({
                                agentRuntimeId,
                                qualifier,
                                agentName: selectedAgent?.label || "Voice Agent",
                            });
                        }}
                        disabled={props.running}
                    >
                        🎙 Start Voice
                    </Button>
                )}
            </SpaceBetween>
        </SpaceBetween>
    );
});

export default ChatInputPanel;
