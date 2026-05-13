// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Alert, Button, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import type { IconProps } from "@cloudscape-design/components/icon";
import { generateClient } from "aws-amplify/api";
import { fetchUserAttributes } from "aws-amplify/auth";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AppContext } from "../../common/app-context";
import { VoiceConversationTurn } from "../../common/hooks/useVoiceAgent";
import { CHATBOT_NAME } from "../../common/constants";
import {
    getDefaultRuntimeConfiguration as getDefaultRuntimeConfigurationQuery,
    getFavoriteRuntime as getFavoriteRuntimeQuery,
    getSession,
    listAgentEndpoints as listAgentEndpointsQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";
import styles from "../../styles/chat.module.scss";
import ChatInputPanel, { ChatInputPanelHandle, ChatScrollState } from "./chat-input-panel";
import ChatMessage from "./chat-message";
import VoiceConversationView from "./VoiceConversationView";
import { AgentOption, ChatBotHistoryItem, ChatBotMessageType, EndpointOption, Feedback, ToolActionItem } from "./types";

/**
 * Chat Component
 *
 * A React component that provides a complete chat interface for the Agentic Chatbot Accelerator application.
 * Manages chat sessions, message history, and real-time communication with the backend.
 *
 * Features:
 * - Session management with optional session restoration
 * - Message history display with feedback support
 * - Dynamic layout with optional annex panel
 * - Error handling and loading states
 * - Internationalization support
 * - Auto-scroll management for chat history
 *
 * @component
 * @param {Object} props - Component properties
 * @param {string} [props.sessionId] - Optional session ID to restore an existing chat session.
 *                                     If provided, loads message history from backend.
 *                                     If not provided, creates a new session with UUID.
 *
 * @returns {JSX.Element} A grid-based chat interface with message history and input panel
 *
 * @example
 * // New chat session
 * <Chat />
 *
 * @example
 * // Restore existing session
 * <Chat sessionId="existing-session-uuid" />
 *
 * State Management:
 * - `running`: Boolean indicating if a message is being processed
 * - `session`: Object containing session ID, loading state, runtime ID, and endpoint
 * - `messageHistory`: Array of ChatBotHistoryItem objects representing conversation
 * - `initError`: String for initialization error messages
 * - `annex`: React element for optional side panel content
 *
 * Layout:
 * - Uses CSS Grid with dynamic columns (1fr or 1fr 2fr based on annex presence)
 * - Main chat area contains message history and input panel
 * - Optional annex panel for additional content (documents, references, etc.)
 */
export default function Chat(props: { sessionId?: string }) {
    const appContext = useContext(AppContext);
    const [running, setRunning] = useState<boolean>(false);
    const [session, setSession] = useState<{
        id: string;
        loading: boolean;
        runtimeId?: string;
        endpoint?: string;
    }>({
        id: props.sessionId ?? uuidv4(),
        loading: typeof props.sessionId !== "undefined",
    });
    const [initError] = useState<string | undefined>(undefined);
    const [messageHistory, setMessageHistory] = useState<ChatBotHistoryItem[]>([]);
    const { t } = useTranslation("ACA");

    const [annex, setAnnex] = useState<React.ReactElement | null>(null);

    const [scrollPaused, setScrollPaused] = useState(false);
    const navigate = useNavigate();

    // ================================================================
    // Lifted Agent / Endpoint state (shared between text & voice views)
    // ================================================================
    const [agentRuntimeId, setAgentRuntimeId] = useState<string>("");
    const [qualifier, setQualifier] = useState<string>("DEFAULT");
    const [availableAgents, setAvailableAgents] = useState<AgentOption[]>([]);
    const [availableEndpoints, setAvailableEndpoints] = useState<EndpointOption[]>([]);
    const [agentsLoading, setAgentsLoading] = useState(true);
    const [endpointsLoading, setEndpointsLoading] = useState(false);
    const [voiceSupported, setVoiceSupported] = useState(false);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    const favoriteQualifierRef = useRef<string | null>(null);
    const sessionEndpointRef = useRef<string | null>(null);
    const client = generateClient();

    // ================================================================
    // Voice mode state
    // ================================================================
    const [voiceMode, setVoiceMode] = useState(false);
    /** Restored voice turns for read-only session display */
    const [restoredVoiceTurns, setRestoredVoiceTurns] = useState<VoiceConversationTurn[] | undefined>(undefined);
    /** User display name from Cognito (for voice bubble labels) */
    const [userName, setUserName] = useState<string | undefined>(undefined);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const lastUserMessageRef = useRef<HTMLDivElement>(null);
    /** Guard: suppress auto-enter voice mode after explicit agent change to non-sonic */
    const suppressAutoVoiceRef = useRef(false);
    /** Ref to ChatInputPanel for imperatively closing the text WebSocket */
    const chatInputPanelRef = useRef<ChatInputPanelHandle>(null);

    // Derived: current agent name
    const agentName = availableAgents.find((a) => a.value === agentRuntimeId)?.label || agentRuntimeId;

    // Derived: agents available
    const agentsAvailable = agentsLoading ? null : availableAgents.length > 0 ? true : false;

    // ================================================================
    // Agent / Endpoint loading logic (lifted from ChatInputPanel)
    // ================================================================

    // Load available runtime agents
    const loadRuntimeAgents = async () => {
        try {
            setAgentsLoading(true);
            const response = await client.graphql({
                query: listRuntimeAgentsQuery,
            });

            const agents: AgentOption[] =
                response.data.listRuntimeAgents?.map((agent: any) => {
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
                        architectureType: agent.architectureType || undefined,
                    };
                }) || [];

            setAvailableAgents(agents);
        } catch (error) {
            console.error("Error fetching runtime agents:", error);
        } finally {
            setAgentsLoading(false);
        }
    };

    // Load agents on mount and on refresh
    useEffect(() => {
        loadRuntimeAgents();
    }, [refreshTrigger]);

    const refreshAgents = () => setRefreshTrigger((prev) => prev + 1);

    // Load favorite runtime for new sessions
    useEffect(() => {
        if (session.loading || session.runtimeId) return;

        if (messageHistory.length === 0 && !agentRuntimeId) {
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
    }, [messageHistory.length, agentRuntimeId, session.loading, session.runtimeId]);

    // Restore agent/endpoint from session (loaded sessions)
    useEffect(() => {
        if (session.runtimeId && messageHistory.length > 0) {
            if (session.endpoint) {
                sessionEndpointRef.current = session.endpoint;
            }
            setAgentRuntimeId(session.runtimeId);
        }
        if (session.endpoint && messageHistory.length > 0) {
            setQualifier(session.endpoint);
        }
    }, [session.runtimeId, session.endpoint, messageHistory.length]);

    // Load endpoints when agentRuntimeId changes
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
            .then((result: any) => {
                const endpoints = result.data?.listAgentEndpoints || [];
                const endpointOptions: EndpointOption[] = endpoints
                    .filter((endpoint: any): endpoint is string => endpoint !== null)
                    .map((endpoint: string) => ({ label: endpoint, value: endpoint }));

                setAvailableEndpoints(endpointOptions);

                // Check if there's a preserved qualifier from session or favorite
                if (sessionEndpointRef.current) {
                    if (endpointOptions.some((e) => e.value === sessionEndpointRef.current)) {
                        setQualifier(sessionEndpointRef.current);
                    } else {
                        if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                            setQualifier("QUALIFIER");
                        } else if (endpointOptions.length > 0) {
                            setQualifier(endpointOptions[0].value);
                        } else {
                            setQualifier("DEFAULT");
                        }
                    }
                    sessionEndpointRef.current = null;
                } else if (favoriteQualifierRef.current) {
                    if (endpointOptions.some((e) => e.value === favoriteQualifierRef.current)) {
                        setQualifier(favoriteQualifierRef.current);
                    } else {
                        if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                            setQualifier("QUALIFIER");
                        } else if (endpointOptions.length > 0) {
                            setQualifier(endpointOptions[0].value);
                        } else {
                            setQualifier("DEFAULT");
                        }
                    }
                    favoriteQualifierRef.current = null;
                } else {
                    if (endpointOptions.some((e) => e.value === "QUALIFIER")) {
                        setQualifier("QUALIFIER");
                    } else if (endpointOptions.length > 0) {
                        setQualifier(endpointOptions[0].value);
                    } else {
                        setQualifier("DEFAULT");
                    }
                }
            })
            .catch((err: any) => {
                console.error("Failed to load endpoints:", err);
                setAvailableEndpoints([{ label: "DEFAULT", value: "DEFAULT" }]);
                setQualifier("DEFAULT");
                favoriteQualifierRef.current = null;
            })
            .finally(() => setEndpointsLoading(false));
    }, [agentRuntimeId]);

    // Check if selected agent supports voice mode
    // (1) architectureType must be SINGLE or AGENTS_AS_TOOLS
    // (2) model must contain "sonic" (Nova Sonic)
    useEffect(() => {
        if (!agentRuntimeId) {
            setVoiceSupported(false);
            return;
        }

        const selectedAgent = availableAgents.find((a) => a.value === agentRuntimeId);
        if (!selectedAgent) {
            setVoiceSupported(false);
            return;
        }

        // Step 1: Check architectureType
        const arch = selectedAgent.architectureType;
        if (arch && arch !== "SINGLE" && arch !== "AGENTS_AS_TOOLS") {
            setVoiceSupported(false);
            return;
        }

        // Step 2: Load agent config to check model
        const checkModel = async () => {
            try {
                const result = await client.graphql({
                    query: getDefaultRuntimeConfigurationQuery,
                    variables: { agentName: selectedAgent.label },
                });
                const config = JSON.parse(result.data.getDefaultRuntimeConfiguration);
                const modelId = config?.modelInferenceParameters?.modelId || "";
                setVoiceSupported(modelId.toLowerCase().includes("sonic"));
            } catch {
                // If we can't load config, default to architectureType check only
                setVoiceSupported(arch === "SINGLE" || arch === "AGENTS_AS_TOOLS" || !arch);
            }
        };
        checkModel();
    }, [agentRuntimeId, availableAgents]);

    // Auto-enter voice mode when a Nova Sonic agent is selected
    useEffect(() => {
        // Guard: skip if we just explicitly exited voice via agent change
        if (suppressAutoVoiceRef.current) {
            suppressAutoVoiceRef.current = false;
            return;
        }

        if (!voiceSupported || !agentRuntimeId) return;
        if (running || messageHistory.length > 0) return; // don't auto-switch mid-conversation
        if (voiceMode) return; // already in voice mode

        const selectedAgent = availableAgents.find((a) => a.value === agentRuntimeId);
        if (!selectedAgent || selectedAgent.iconName !== "status-positive") return;

        // Close the text WebSocket before entering voice mode to avoid
        // session conflict on AgentCore (only one WS per session allowed).
        const enterVoice = async () => {
            if (chatInputPanelRef.current) {
                await chatInputPanelRef.current.closeWebSocket();
            }
            setVoiceMode(true);
            setRestoredVoiceTurns(undefined);
        };
        enterVoice();
    }, [voiceSupported, agentRuntimeId, qualifier, availableAgents]);

    // ================================================================
    // Scroll management
    // ================================================================

    // Scroll management when message history changes:
    // - On new message send: scroll so the user's message is at the top of the viewport
    // - During streaming: auto-scroll to follow the growing response, but STOP once
    //   scrolling further would push the user's question off the top of the viewport.
    useLayoutEffect(() => {
        if (ChatScrollState.skipNextHistoryUpdate) {
            return;
        }

        if (messageHistory.length < 2) {
            return;
        }

        const container = chatContainerRef.current;
        if (!container) return;

        // When a new message was just sent (or session loaded), scroll the user's message to the top
        if (ChatScrollState.scrollToUserMessage) {
            ChatScrollState.scrollToUserMessage = false;
            setScrollPaused(false);

            if (lastUserMessageRef.current) {
                // Use scrollIntoView — works reliably regardless of RTL, flex, or DOM nesting
                lastUserMessageRef.current.scrollIntoView({ behavior: "instant", block: "start" });
            }
            return;
        }

        // During streaming: auto-scroll to follow the response, but only as long as
        // the user's question message would remain visible at the top of the viewport
        if (!ChatScrollState.userHasScrolled && lastUserMessageRef.current) {
            const containerRect = container.getBoundingClientRect();
            const messageRect = lastUserMessageRef.current.getBoundingClientRect();

            // Check: is the user's message currently visible in the container?
            const isUserMessageVisible = messageRect.top >= containerRect.top;

            if (isUserMessageVisible) {
                // Calculate where the user message would be if we scrolled to the very bottom
                const maxScrollTop = container.scrollHeight - container.clientHeight;
                const userMsgOffsetInContainer = lastUserMessageRef.current.offsetTop
                    || (messageRect.top - containerRect.top + container.scrollTop);

                // If scrolling to bottom would still keep user message visible (within container top)
                if (userMsgOffsetInContainer >= maxScrollTop) {
                    // Safe to scroll — user message would still be at or above the fold
                    container.scrollTop = container.scrollHeight;
                } else {
                    // Scrolling further would push user message off the top — stop auto-scrolling
                    ChatScrollState.userHasScrolled = true;
                    setScrollPaused(true);
                }
            } else {
                // User message is already out of view — stop
                ChatScrollState.userHasScrolled = true;
                setScrollPaused(true);
            }
        }
    }, [messageHistory]);

    // Reset scrollPaused when generation completes
    useEffect(() => {
        if (!running) {
            setScrollPaused(false);
        }
    }, [running]);

    // Detect user scrolling on the chat container to pause auto-scroll
    useEffect(() => {
        const container = chatContainerRef.current;
        if (!container) return;

        const onContainerScroll = () => {
            if (ChatScrollState.skipNextScrollEvent) {
                ChatScrollState.skipNextScrollEvent = false;
                return;
            }

            const isAtBottom =
                Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) <=
                10;

            if (!isAtBottom) {
                ChatScrollState.userHasScrolled = true;
            } else {
                ChatScrollState.userHasScrolled = false;
            }
        };

        container.addEventListener("scroll", onContainerScroll);
        return () => container.removeEventListener("scroll", onContainerScroll);
    }, []);

    // ================================================================
    // Session loading
    // ================================================================

    useEffect(() => {
        if (!appContext) return;

        setMessageHistory([]);

        (async () => {
            if (!props.sessionId) {
                setSession({ id: uuidv4(), loading: false });
                return;
            }

            setSession({ id: props.sessionId, loading: true });
            const apiClient = generateClient();

            try {
                const result = await apiClient.graphql({
                    query: getSession,
                    variables: { id: props.sessionId },
                });
                if (result.data?.getSession?.history) {
                    // load history
                    console.log(result.data.getSession);
                    // Scroll to the last user message after history renders
                    ChatScrollState.scrollToUserMessage = true;
                    console.log("History", result.data.getSession.history);
                    setMessageHistory(
                        result
                            .data!.getSession!.history.filter((x) => x !== null)
                            .map((x) => ({
                                type: x!.type as ChatBotMessageType,
                                content: x!.content,
                                references: x!.references ? x!.references : undefined,
                                messageId: x.messageId,
                                feedback: x!.feedback
                                    ? (JSON.parse(x!.feedback) as Feedback)
                                    : undefined,
                                complete: true,
                                executionTimeMs: x!.executionTimeMs
                                    ? x!.executionTimeMs
                                    : undefined,
                                reasoningContent: x!.reasoningContent
                                    ? x!.reasoningContent
                                    : undefined,
                                structuredOutput: x!.structuredOutput
                                    ? x!.structuredOutput
                                    : undefined,
                                toolActions: x!.toolActions
                                    ? (JSON.parse(x!.toolActions) as ToolActionItem[])
                                    : undefined,
                                tokens: [
                                    // put dummy token here just to render the "Thinking Process" component
                                    {
                                        sequenceNumber: 0,
                                        value: "",
                                        runId: "history",
                                    },
                                ],
                            })),
                    );

                    setSession({
                        id: props.sessionId,
                        loading: false,
                        runtimeId: result.data.getSession.runtimeId,
                        endpoint: result.data.getSession.endpoint,
                    });
                } else {
                    setSession({ id: props.sessionId, loading: false });
                }
            } catch (error) {
                console.log(error);
                setSession({ id: props.sessionId, loading: false });
            }

            setRunning(false);
        })();
    }, [appContext, props.sessionId]);

    // Fetch user display name from Cognito for voice bubble labels
    useEffect(() => {
        fetchUserAttributes()
            .then((attrs) => {
                // Prefer name, then given_name, then email, then sub
                const displayName = attrs.name || attrs.given_name || attrs.email || attrs.sub;
                if (displayName) setUserName(displayName);
            })
            .catch(() => {
                // Fallback — leave as undefined (will show "You")
            });
    }, []);

    // ================================================================
    // Voice mode handlers
    // ================================================================

    /** Called from ChatInputPanel when user clicks "Start Voice" */
    const handleVoiceStart = async (info: { agentRuntimeId: string; qualifier: string; agentName: string }) => {
        // Close the text WebSocket BEFORE entering voice mode.
        // AgentCore only allows one WebSocket per session — if the text WS
        // is still alive when voice connects, the server will kill one of them.
        if (chatInputPanelRef.current) {
            await chatInputPanelRef.current.closeWebSocket();
        }
        // Ensure lifted state matches what was passed
        setAgentRuntimeId(info.agentRuntimeId);
        setQualifier(info.qualifier);
        setVoiceMode(true);
        setRestoredVoiceTurns(undefined);
    };

    /** Called when a live voice session ends — convert voice turns to text chat format */
    const handleVoiceConversationEnd = async (turns: VoiceConversationTurn[]) => {
        if (turns.length === 0) return;

        try {
            // Convert voice turns into the text chat history format.
            // Each user→assistant exchange gets a unique messageId (paired).
            const historyItems: ChatBotHistoryItem[] = [];
            let currentUserText = "";
            let currentAssistantText = "";
            let pairCount = 0;

            const flushPair = () => {
                if (!currentUserText && !currentAssistantText) return;
                pairCount++;
                const pairId = `voice-${pairCount}-${crypto.randomUUID().slice(0, 8)}`;

                if (currentUserText) {
                    historyItems.push({
                        type: ChatBotMessageType.Human,
                        content: currentUserText.trim(),
                        messageId: pairId,
                    });
                }
                if (currentAssistantText) {
                    historyItems.push({
                        type: ChatBotMessageType.AI,
                        content: currentAssistantText.trim(),
                        messageId: pairId,
                        complete: true,
                        tokens: [{ sequenceNumber: 0, value: "", runId: "voice" }],
                    });
                }
                currentUserText = "";
                currentAssistantText = "";
            };

            for (const turn of turns) {
                if (!turn.isFinal) continue;

                if (turn.role === "user") {
                    // If we already have assistant text, flush the current pair first
                    if (currentAssistantText) {
                        flushPair();
                    }
                    currentUserText += (currentUserText ? " " : "") + turn.text;
                } else if (turn.role === "assistant") {
                    currentAssistantText += (currentAssistantText ? " " : "") + turn.text;
                } else if (turn.role === "tool") {
                    currentAssistantText += (currentAssistantText ? "\n" : "") + `🔧 ${turn.text}`;
                }
            }

            // Flush final pair
            flushPair();

            // Update local message history
            setMessageHistory(historyItems);
            console.log(`Voice conversation rendered: ${historyItems.length} messages (${pairCount} pairs)`);
        } catch (err) {
            console.error("Failed to process voice conversation:", err);
        }
    };

    /** Called when user exits voice mode */
    const handleVoiceExit = () => {
        setVoiceMode(false);
        setRestoredVoiceTurns(undefined);
    };

    /**
     * Called from VoiceConversationView when user changes agent in the voice dropdown.
     * If the new agent is sonic-capable, stay in voice mode (reconnect).
     * If not, exit voice mode and return to text chat.
     */
    const handleAgentChangeFromVoice = (newAgentId: string, newQualifier: string, isSonic: boolean) => {
        if (!isSonic) {
            // Prevent auto-enter voice from re-triggering before voiceSupported updates
            suppressAutoVoiceRef.current = true;
        }
        setAgentRuntimeId(newAgentId);
        setQualifier(newQualifier);
        if (!isSonic) {
            handleVoiceExit();
        }
        // If sonic, VoiceConversationView will reconnect with new agentRuntimeId/qualifier via props
    };

    // ================================================================
    // Render: Voice mode vs Text mode
    // ================================================================
    if (voiceMode && agentRuntimeId) {
        return (
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr",
                    width: "100%",
                    height: "100%",
                }}
            >
                <div className={styles.chat_meta_container}>
                    <div className={styles.chat_container}>
                        <VoiceConversationView
                            agentRuntimeId={agentRuntimeId}
                            qualifier={qualifier}
                            sessionId={session.id}
                            agentName={agentName}
                            userName={userName}
                            onExit={handleVoiceExit}
                            onConversationEnd={handleVoiceConversationEnd}
                            restoredTurns={restoredVoiceTurns}
                            availableAgents={availableAgents}
                            availableEndpoints={availableEndpoints}
                            agentsLoading={agentsLoading}
                            endpointsLoading={endpointsLoading}
                            onAgentChange={handleAgentChangeFromVoice}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: annex ? "1fr 2fr" : "1fr",
                width: "100%",
                height: "100%",
            }}
        >
            <div className={styles.chat_meta_container} ref={chatContainerRef}>
                <div className={styles.chat_container}>
                    {initError && (
                        <Alert
                            statusIconAriaLabel="Error"
                            type="error"
                            header="Unable to initialize the chatbot"
                        >
                            {initError}
                        </Alert>
                    )}
                    {agentsAvailable === null && (
                        <Alert type="info">
                            <StatusIndicator type="loading">
                                Looking for available AgentCore runtimes
                            </StatusIndicator>
                        </Alert>
                    )}
                    {agentsAvailable === false && (
                        <Alert type="warning" header="No AgentCore Runtimes Available">
                            You need to create an agent runtime before you can start chatting.{" "}
                            <Button
                                external
                                variant="inline-link"
                                onClick={() => navigate("/agent-core")}
                            >
                                Create one now
                            </Button>
                        </Alert>
                    )}

                    <div ref={messagesContainerRef}>
                        <SpaceBetween direction="vertical" size="m">
                            {messageHistory.map((message, idx) => {
                                // Find the last user message to attach the scroll ref
                                const isLastUserMessage =
                                    message.type === ChatBotMessageType.Human &&
                                    !messageHistory
                                        .slice(idx + 1)
                                        .some(
                                            (m) => m.type === ChatBotMessageType.Human,
                                        );
                                return (
                                    <div
                                        key={idx}
                                        ref={
                                            isLastUserMessage
                                                ? lastUserMessageRef
                                                : undefined
                                        }
                                    >
                                        <ChatMessage
                                            message={message}
                                            sessionId={session.id}
                                            setAnnex={setAnnex}
                                        />
                                    </div>
                                );
                            })}
                        </SpaceBetween>
                    </div>
                    <div className={styles.welcome_text}>
                        {messageHistory.length == 0 && !session?.loading && (
                            <center>{CHATBOT_NAME}</center>
                        )}
                        {session?.loading && (
                            <StatusIndicator type="loading">
                                {t("CHATBOT.PLAYGROUND.LOADING_MSG")}
                            </StatusIndicator>
                        )}
                    </div>

                    <div className={styles.input_container}>
                        {running && scrollPaused && (
                            <div style={{ textAlign: "center", paddingBottom: "8px" }}>
                                <StatusIndicator type="loading">
                                    Still generating response — scroll down to see more
                                </StatusIndicator>
                            </div>
                        )}
                        <ChatInputPanel
                            ref={chatInputPanelRef}
                            session={session}
                            running={running}
                            setRunning={setRunning}
                            messageHistory={messageHistory}
                            setMessageHistory={(history) => setMessageHistory(history)}
                            agentRuntimeId={agentRuntimeId}
                            setAgentRuntimeId={setAgentRuntimeId}
                            qualifier={qualifier}
                            setQualifier={setQualifier}
                            availableAgents={availableAgents}
                            availableEndpoints={availableEndpoints}
                            agentsLoading={agentsLoading}
                            endpointsLoading={endpointsLoading}
                            voiceSupported={voiceSupported}
                            refreshAgents={refreshAgents}
                            onVoiceStart={handleVoiceStart}
                        />
                    </div>
                </div>
            </div>
            {annex}{" "}
        </div>
    );
}
