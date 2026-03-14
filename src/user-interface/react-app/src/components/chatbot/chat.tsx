// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Alert, Button, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AppContext } from "../../common/app-context";
import { CHATBOT_NAME } from "../../common/constants";
import { getSession } from "../../graphql/queries";
import styles from "../../styles/chat.module.scss";
import ChatInputPanel, { ChatScrollState } from "./chat-input-panel";
import ChatMessage from "./chat-message";
import { ChatBotHistoryItem, ChatBotMessageType, Feedback, ToolActionItem } from "./types";

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

    const [agentsAvailable, setAgentsAvailable] = useState<boolean | null>(null);
    const navigate = useNavigate();
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when message history changes
    // Only scroll if the messages content actually exceeds the available viewport space
    useLayoutEffect(() => {
        if (ChatScrollState.skipNextHistoryUpdate) {
            return;
        }

        if (messageHistory.length < 2) {
            return;
        }

        const container = chatContainerRef.current;
        const messagesContainer = messagesContainerRef.current;
        if (!ChatScrollState.userHasScrolled && container && messagesContainer) {
            // Get the height of the messages content
            const messagesHeight = messagesContainer.getBoundingClientRect().height;
            // Get the visible height of the scroll container
            const containerHeight = container.clientHeight;

            // Only scroll if messages content is taller than the visible area
            // (with some margin for the input area and padding)
            if (messagesHeight > containerHeight * 0.6) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [messageHistory]);

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
                    ChatScrollState.skipNextHistoryUpdate = true;
                    ChatScrollState.skipNextScrollEvent = true;
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

                    window.scrollTo({
                        top: 0,
                        behavior: "instant",
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

    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: annex ? "1fr 2fr" : "1fr",
                width: "100%",
                height: "100%", // Adjust as needed
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
                            {messageHistory.map((message, idx) => (
                                <ChatMessage
                                    key={idx}
                                    message={message}
                                    sessionId={session.id}
                                    setAnnex={setAnnex}
                                />
                            ))}
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
                        <ChatInputPanel
                            session={session}
                            running={running}
                            setRunning={setRunning}
                            messageHistory={messageHistory}
                            setMessageHistory={(history) => setMessageHistory(history)}
                            onAgentsAvailable={setAgentsAvailable}
                        />
                    </div>
                </div>
            </div>
            {annex}{" "}
        </div>
    );
}
