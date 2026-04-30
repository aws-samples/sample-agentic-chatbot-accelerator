// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Button, FormField, Select, SpaceBetween } from "@cloudscape-design/components";
import PromptInput from "@cloudscape-design/components/prompt-input";
import { generateClient } from "aws-amplify/api";
import { Dispatch, SetStateAction, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";

import { fetchUserAttributes } from "aws-amplify/auth";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import { saveToolActions, updateMessageExecutionTime } from "../../graphql/mutations";
import { receiveMessages } from "../../graphql/subscriptions";

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
import { updateMessageHistoryRef } from "./utils";

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

export default function ChatInputPanel(props: ChatInputPanelProps) {
    const appContext = useContext(AppContext);
    const [state, setState] = useState<{ value: string }>({
        value: "",
    });
    const [readyState, setReadyState] = useState<ReadyState>(ReadyState.UNINSTANTIATED);

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
    const client = generateClient();

    useEffect(() => {
        messageHistoryRef.current = props.messageHistory;
    }, [props.messageHistory]);

    // ================================================================
    // Direct WebSocket connection to AgentCore (replaces AppSync sub)
    // ================================================================
    useEffect(() => {
        if (!agentRuntimeId || !qualifier || !appContext) return;

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
                setReadyState(ReadyState.OPEN);
                console.log(`WebSocket connected for session ${props.session.id}`);
            },

            onDisconnected: () => {
                setReadyState(ReadyState.CLOSED);
                console.log(`WebSocket disconnected for session ${props.session.id}`);
                wsConnectionRef.current = null;
            },

            onTextToken: (data: string, sequenceNumber: number, runId?: string) => {
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

                    // Save tool actions with a delay — they arrive via the AppSync
                    // side-channel and the DynamoDB session record needs time to be
                    // written by the container before we can update it.
                    const saveToolActionsWithRetry = (attempt: number) => {
                        const currentMsg =
                            messageHistoryRef.current[messageHistoryRef.current.length - 1];
                        if (currentMsg?.toolActions && currentMsg.toolActions.length > 0) {
                            client
                                .graphql({
                                    query: saveToolActions,
                                    variables: {
                                        sessionId: props.session.id,
                                        messageId: currentMsg.messageId,
                                        toolActions: JSON.stringify(currentMsg.toolActions),
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
                    // First attempt after 3s delay (allows container DynamoDB write + side-channel delivery)
                    setTimeout(() => saveToolActionsWithRetry(1), 3000);
                }
                props.setRunning(false);
            },

            // Raw tool descriptions from WebSocket are suppressed — we only show
            // the AI-rephrased descriptions that arrive via the AppSync side-channel.
            // The raw description is logged for debugging but not displayed.
            onToolAction: (toolName: string, _description: string, invocationNumber: number) => {
                console.debug(
                    `Raw tool action #${invocationNumber} (${toolName}) — waiting for AI-rephrased version`,
                );
            },

            onError: (errorMessage: string) => {
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
                wsConnectionRef.current = conn;
                console.log(`WebSocket connected to AgentCore for session ${props.session.id}`);
            })
            .catch((err) => {
                console.error("Failed to establish WebSocket connection:", err);
                setReadyState(ReadyState.CLOSED);
            });

        return () => {
            if (wsConnectionRef.current) {
                console.log(`Closing WebSocket for session ${props.session.id}`);
                wsConnectionRef.current.close();
                wsConnectionRef.current = null;
            }
        };
    }, [props.session.id, agentRuntimeId, qualifier, appContext]);

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

    // ================================================================
    // AppSync side-channel: receive AI-rephrased tool descriptions
    // A Lambda function publishes to the Messages SNS Topic, which triggers
    // the outbound handler Lambda → AppSync publishResponse → this subscription.
    // We only process tool_action events here; all other events come via WebSocket.
    // ================================================================
    useEffect(() => {
        const sideChannelToolActions: { [key: string]: ToolActionItem[] } = {};

        const sub = client
            .graphql({
                query: receiveMessages,
                variables: { sessionId: props.session.id },
                authMode: "userPool",
            })
            .subscribe({
                next: (message) => {
                    const data = message.data?.receiveMessages?.data;
                    if (!data) return;

                    try {
                        const response: ChatBotMessageResponse = JSON.parse(data);

                        // Only process tool_action events from this side channel
                        // (all other events are handled via direct WebSocket)
                        if (response.action === ChatBotAction.ToolAction) {
                            console.log("AI-rephrased tool action via AppSync:", response.data);

                            // Add the AI-rephrased tool action to the message history
                            // using the same mechanism as the original code
                            updateMessageHistoryRef(
                                props.session.id,
                                messageHistoryRef.current,
                                response,
                                {}, // no token tracking needed for tool actions
                                sideChannelToolActions,
                            );
                            props.setMessageHistory([...messageHistoryRef.current]);

                            // Persist accumulated tool actions to DynamoDB
                            // (saves on each tool action arrival so the latest state is always persisted)
                            const lastMsg =
                                messageHistoryRef.current[messageHistoryRef.current.length - 1];
                            if (lastMsg?.toolActions && lastMsg.toolActions.length > 0) {
                                client
                                    .graphql({
                                        query: saveToolActions,
                                        variables: {
                                            sessionId: props.session.id,
                                            messageId: lastMsg.messageId,
                                            toolActions: JSON.stringify(lastMsg.toolActions),
                                        },
                                    })
                                    .catch((err) =>
                                        console.error("Failed to save tool actions:", err),
                                    );
                            }
                        }
                        // Ignore all non-tool_action events (they come via WebSocket)
                    } catch (err) {
                        console.warn("Failed to parse AppSync side-channel message:", err);
                    }
                },
                error: (error) => console.warn("AppSync side-channel subscription error:", error),
            });

        return () => {
            sub.unsubscribe();
        };
    }, [props.session.id]);

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

        props.setRunning(true);
        const startTime = Date.now();
        messageHistoryRef.current = [
            ...messageHistoryRef.current,
            {
                type: ChatBotMessageType.Human,
                messageId: message_id,
                content: value,
            },
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

            wsConnectionRef.current.send({
                type: "text_input",
                text: value,
                sessionId: props.session.id,
                userId,
                messageId: message_id,
                agentRuntimeId: agentRuntimeId,
                qualifier: qualifier,
            });
        } catch (err) {
            console.log(Utils.getErrorMessage(err));
            props.setRunning(false);
            messageHistoryRef.current[messageHistoryRef.current.length - 1].content =
                "**Error**, Unable to process the request: " + Utils.getErrorMessage(err);
            props.setMessageHistory(messageHistoryRef.current);
        }
    };

    const isSelectedAgentReady = () => {
        if (!agentRuntimeId) return false;
        const selectedAgent = availableAgents.find((agent) => agent.value === agentRuntimeId);
        return selectedAgent?.iconName === "status-positive";
    };

    return (
        <SpaceBetween direction="vertical" size="l">
            <PromptInput
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
                disabled={props.running || !agentRuntimeId || !isSelectedAgentReady()}
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
                            <Button
                                iconName="refresh"
                                variant="icon"
                                onClick={refreshAgents}
                                disabled={agentsLoading}
                            />
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
}
