// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Button, FormField, Select, SpaceBetween } from "@cloudscape-design/components";
import type { IconProps } from "@cloudscape-design/components/icon";
import PromptInput from "@cloudscape-design/components/prompt-input";
import { generateClient } from "aws-amplify/api";
import { Dispatch, SetStateAction, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";

import { Utils } from "../../common/utils";
import { saveToolActions, sendQuery, updateMessageExecutionTime } from "../../graphql/mutations";
import {
    getFavoriteRuntime as getFavoriteRuntimeQuery,
    listAgentEndpoints as listAgentEndpointsQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";

import { receiveMessages } from "../../graphql/subscriptions";

import {
    ChatBotAction,
    ChatBotHeartbeatRequest,
    ChatBotHistoryItem,
    ChatBotMessageResponse,
    ChatBotMessageType,
    ChatBotRunRequest,
    ChatInputState,
    Framework,
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
    onAgentsAvailable?: (available: boolean) => void;
}

export abstract class ChatScrollState {
    static userHasScrolled = false;
    static skipNextScrollEvent = false;
    static skipNextHistoryUpdate = false;
}

export default function ChatInputPanel(props: ChatInputPanelProps) {
    const [state, setState] = useState<ChatInputState>({
        value: "",
    });
    const [readyState, setReadyState] = useState<ReadyState>(ReadyState.UNINSTANTIATED);
    const [agentRuntimeId, setAgentRuntimeId] = useState<string>("");
    const [qualifier, setQualifier] = useState<string>("DEFAULT");
    const [availableAgents, setAvailableAgents] = useState<
        { label: string; value: string; iconName?: IconProps.Name; disabled?: boolean }[]
    >([]);
    const [agentsLoading, setAgentsLoading] = useState(true);
    const [availableEndpoints, setAvailableEndpoints] = useState<
        Array<{ label: string; value: string }>
    >([]);
    const [endpointsLoading, setEndpointsLoading] = useState(false);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);
    const favoriteQualifierRef = useRef<string | null>(null);
    const sessionEndpointRef = useRef<string | null>(null);
    const client = generateClient();

    useEffect(() => {
        messageHistoryRef.current = props.messageHistory;
    }, [props.messageHistory]);

    // Load favorite runtime for new sessions
    useEffect(() => {
        if (props.session.loading || props.session.runtimeId) return;

        if (props.messageHistory.length === 0 && !agentRuntimeId) {
            const loadFavoriteRuntime = async () => {
                try {
                    const result = await client.graphql({ query: getFavoriteRuntimeQuery });
                    const favorite = result.data.getFavoriteRuntime;
                    if (favorite) {
                        favoriteQualifierRef.current = favorite.endpointName;
                        setAgentRuntimeId(favorite.agentRuntimeId);
                        setQualifier(favorite.endpointName);
                    }
                } catch (error) {
                    // No favorite set, continue with defaults
                }
            };
            loadFavoriteRuntime();
        }
    }, [
        props.messageHistory.length,
        agentRuntimeId,
        props.session.loading,
        props.session.runtimeId,
    ]);

    useEffect(() => {
        console.log(props.session);
        if (props.session.runtimeId && props.messageHistory.length > 0) {
            // Store the session endpoint before changing runtime to prevent it from being overwritten
            if (props.session.endpoint) {
                sessionEndpointRef.current = props.session.endpoint;
            }
            setAgentRuntimeId(props.session.runtimeId);
        }
        if (props.session.endpoint && props.messageHistory.length > 0) {
            setQualifier(props.session.endpoint);
        }
    }, [props.session.runtimeId, props.session.endpoint, props.messageHistory.length]);

    // Load available runtime agents
    const loadRuntimeAgents = async () => {
        try {
            setAgentsLoading(true);
            const response = await client.graphql({
                query: listRuntimeAgentsQuery,
            });

            const agents =
                response.data.listRuntimeAgents?.map((agent) => {
                    const getStatusIcon = (status: string): IconProps.Name => {
                        switch (status.toLowerCase()) {
                            case "ready":
                                return "status-positive";
                            case "updating":
                                return "status-pending";
                            case "failed":
                                return "status-negative";
                            default:
                                return "status-info";
                        }
                    };
                    return {
                        label: agent.agentName,
                        value: agent.agentRuntimeId,
                        iconName: getStatusIcon(agent.status),
                        disabled: agent.status.toLowerCase() !== "ready",
                    };
                }) || [];

            setAvailableAgents(agents);
        } catch (error) {
            console.error("Error fetching runtime agents:", error);
        } finally {
            setAgentsLoading(false);
        }
    };

    // Update useEffect to include refreshTrigger
    useEffect(() => {
        loadRuntimeAgents();
    }, [refreshTrigger]);

    // Add refresh function
    const refreshAgents = () => setRefreshTrigger((prev) => prev + 1);
    useEffect(() => {
        if (!agentsLoading) {
            props.onAgentsAvailable?.(availableAgents.length > 0);
        }
    }, [agentsLoading, availableAgents.length, props.onAgentsAvailable]);

    useEffect(() => {
        if (!agentRuntimeId) {
            setAvailableEndpoints([{ label: "DEFAULT", value: "DEFAULT" }]);
            setQualifier("DEFAULT");
            return;
        }

        setEndpointsLoading(true);
        client
            .graphql({
                query: listAgentEndpointsQuery,
                variables: { agentRuntimeId },
            })
            .then((result) => {
                const endpoints = result.data?.listAgentEndpoints || [];
                const endpointOptions = endpoints
                    .filter((endpoint): endpoint is string => endpoint !== null)
                    .map((endpoint) => ({ label: endpoint, value: endpoint }));

                setAvailableEndpoints(endpointOptions);

                // Check if there's a preserved qualifier from session or favorite
                if (sessionEndpointRef.current) {
                    // Check if the session endpoint exists in available endpoints
                    if (endpointOptions.some((e) => e.value === sessionEndpointRef.current)) {
                        setQualifier(sessionEndpointRef.current);
                    } else {
                        // Session endpoint doesn't exist, fall back to auto-selection
                        if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                            setQualifier("QUALIFIER");
                        } else if (endpointOptions.length > 0) {
                            setQualifier(endpointOptions[0].value);
                        } else {
                            setQualifier("DEFAULT");
                        }
                    }
                    sessionEndpointRef.current = null; // Clear the flag after use
                } else if (favoriteQualifierRef.current) {
                    // Check if the favorite qualifier exists in available endpoints
                    if (endpointOptions.some((e) => e.value === favoriteQualifierRef.current)) {
                        setQualifier(favoriteQualifierRef.current);
                    } else {
                        // Favorite endpoint doesn't exist, fall back to auto-selection
                        if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                            setQualifier("QUALIFIER");
                        } else if (endpointOptions.length > 0) {
                            setQualifier(endpointOptions[0].value);
                        } else {
                            setQualifier("DEFAULT");
                        }
                    }
                    favoriteQualifierRef.current = null; // Clear the flag after use
                } else {
                    // No favorite, use auto-selection for runtime switching
                    if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                        setQualifier("QUALIFIER");
                    } else if (endpointOptions.length > 0) {
                        setQualifier(endpointOptions[0].value);
                    } else {
                        setQualifier("DEFAULT");
                    }
                }
            })
            .catch((err) => {
                console.error("Failed to load endpoints:", err);
                setAvailableEndpoints([{ label: "DEFAULT", value: "DEFAULT" }]);
                setQualifier("DEFAULT");
                favoriteQualifierRef.current = null; // Clear on error
            })
            .finally(() => setEndpointsLoading(false));
    }, [agentRuntimeId]);

    useEffect(() => {
        async function subscribe() {
            console.log("Subscribing to AppSync");
            const messageTokens: { [key: string]: LLMToken[] } = {};
            const toolActions: { [key: string]: ToolActionItem[] } = {};
            // const thinkingTokens: { [key: string]: LLMToken[] } = {};

            setReadyState(ReadyState.CONNECTING);

            const sub = await client
                .graphql({
                    query: receiveMessages,
                    variables: {
                        sessionId: props.session.id,
                    },
                    authMode: "userPool",
                })
                .subscribe({
                    next: (message) => {
                        const data = message.data!.receiveMessages?.data;
                        if (data !== undefined && data !== null) {
                            const response: ChatBotMessageResponse = JSON.parse(data);
                            console.log("message data: ", response.data);
                            if (response.action === ChatBotAction.Heartbeat) {
                                console.log("Heartbeat pong!");
                                return;
                            }

                            updateMessageHistoryRef(
                                props.session.id,
                                messageHistoryRef.current,
                                response,
                                messageTokens,
                                toolActions,
                                // thinkingTokens,
                            );

                            props.setMessageHistory([...messageHistoryRef.current]);

                            if (
                                response.action === ChatBotAction.FinalResponse ||
                                response.action === ChatBotAction.Error
                            ) {
                                console.log("Final message received");
                                const lastMessage =
                                    messageHistoryRef.current[messageHistoryRef.current.length - 1];
                                if (lastMessage && lastMessage.type === ChatBotMessageType.AI) {
                                    lastMessage.complete = true;
                                    if (lastMessage.startTime) {
                                        lastMessage.endTime = Date.now();
                                        lastMessage.executionTimeMs =
                                            lastMessage.endTime - lastMessage.startTime;
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
                                                console.error(
                                                    "Failed to save execution time:",
                                                    err,
                                                ),
                                            );
                                    }

                                    // Save tool actions if any were performed
                                    const messageIndex = messageHistoryRef.current.length - 1;
                                    if (
                                        toolActions[messageIndex] &&
                                        toolActions[messageIndex].length > 0
                                    ) {
                                        client
                                            .graphql({
                                                query: saveToolActions,
                                                variables: {
                                                    sessionId: props.session.id,
                                                    messageId: lastMessage.messageId,
                                                    toolActions: JSON.stringify(
                                                        toolActions[messageIndex],
                                                    ),
                                                },
                                            })
                                            .catch((err) =>
                                                console.error("Failed to save tool actions:", err),
                                            );
                                    }
                                }
                                props.setRunning(false);
                            }
                        }
                    },
                    error: (error) => console.warn(error),
                });
            return sub;
        }

        const sub = subscribe();

        sub.then(() => {
            setReadyState(ReadyState.OPEN);
            console.log(`Subscribed to session ${props.session.id}`);
        }).catch((err) => {
            console.log(err);
            setReadyState(ReadyState.CLOSED);
        });

        return () => {
            sub.then((s) => {
                console.log(`Unsubscribing from ${props.session.id}`);
                s.unsubscribe();
            }).catch((err) => console.log(err));
        };
    }, [props.session.id]);

    useEffect(() => {
        console.log("Heartbeat effect triggered:", {
            agentRuntimeId,
            qualifier,
            readyState,
            messageCount: props.messageHistory.length,
        });

        // Only send heartbeat for new sessions (no messages yet)
        if (!agentRuntimeId || readyState !== ReadyState.OPEN || props.messageHistory.length > 0)
            return;

        const request: ChatBotHeartbeatRequest = {
            action: ChatBotAction.Heartbeat,
            framework: Framework.AGENT_CORE,
            data: {
                sessionId: props.session.id,
                agentRuntimeId: agentRuntimeId,
                qualifier: qualifier,
            },
        };

        client
            .graphql({
                query: sendQuery,
                variables: {
                    data: JSON.stringify(request),
                },
            })
            .then((x) => console.log("Heartbeat sent", x))
            .catch((err) => console.log(Utils.getErrorMessage(err)));
    }, [props.session.id, agentRuntimeId, qualifier, readyState, props.messageHistory.length]);

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

    useLayoutEffect(() => {
        if (ChatScrollState.skipNextHistoryUpdate) {
            ChatScrollState.skipNextHistoryUpdate = false;
            return;
        }

        if (!ChatScrollState.userHasScrolled && props.messageHistory.length > 0) {
            ChatScrollState.skipNextScrollEvent = true;
            window.scrollTo({
                top: document.documentElement.scrollHeight + 1000,
                behavior: "instant",
            });
        }
    }, [props.messageHistory]);

    const generateMessageId = (messageNumber: number): string => {
        const uuid = crypto.randomUUID();
        return `msg-${messageNumber}-${uuid}`;
    };

    const handleSendMessage = async (value: string): Promise<void> => {
        if (props.running) return;
        if (readyState !== ReadyState.OPEN) return;
        if (!agentRuntimeId) return;

        ChatScrollState.userHasScrolled = false;

        const message_id = generateMessageId(messageHistoryRef.current.length);

        const request: ChatBotRunRequest = {
            action: ChatBotAction.Run,
            framework: Framework.AGENT_CORE,
            data: {
                sessionId: props.session.id,
                messageId: message_id,
                text: value,
                agentRuntimeId: agentRuntimeId,
                qualifier: qualifier,
            },
        };

        console.log(request);
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
            await client.graphql({
                query: sendQuery,
                variables: {
                    data: JSON.stringify(request),
                },
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
            </SpaceBetween>
        </SpaceBetween>
    );
}
