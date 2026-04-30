// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// VoiceConversationView
//
// Dedicated voice conversation UI. Replaces the text chat area when voice
// mode is active. Shows completed turns as markdown, active turns as an
// animated waveform, and a sticky footer with recording controls.
//
import { Alert, Box, Button, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../../common/app-context";
import { useVoiceAgent, VoiceConversationTurn } from "../../common/hooks/useVoiceAgent";
import { receiveMessages } from "../../graphql/subscriptions";
import { ConnectOptions } from "../../websocket-presigned";
import { ChatBotAction, ChatBotMessageResponse } from "./types";
import MarkdownContent from "./side-view/markdown-content";

export interface VoiceConversationViewProps {
    agentRuntimeId: string;
    qualifier: string;
    sessionId: string;
    agentName: string;
    userName?: string;
    onExit: () => void;
    onConversationEnd: (turns: VoiceConversationTurn[]) => void;
    restoredTurns?: VoiceConversationTurn[];
}

export default function VoiceConversationView({
    agentRuntimeId,
    qualifier,
    sessionId,
    agentName,
    userName,
    onExit,
    onConversationEnd,
    restoredTurns,
}: VoiceConversationViewProps) {
    const appContext = useContext(AppContext);
    const logEndRef = useRef<HTMLDivElement>(null);
    const isReadOnly = !!restoredTurns;
    const [sessionEnded, setSessionEnded] = useState(false);

    const voiceOptions = useMemo(
        () => ({
            agentRuntimeId,
            accountId: appContext?.aws_account_id || "",
            qualifier,
            sessionId,
            config: {
                aws_project_region: appContext?.aws_project_region || "",
                aws_user_pools_id: appContext?.aws_user_pools_id || "",
                aws_cognito_identity_pool_id: appContext?.aws_cognito_identity_pool_id || "",
            } as ConnectOptions["config"],
        }),
        [agentRuntimeId, qualifier, sessionId, appContext],
    );

    const { isRecording, isConnected, conversationTurns, activeSpeaker, startVoice, stopVoice, disconnectVoice, error } =
        useVoiceAgent(voiceOptions);

    // AI-rephrased tool descriptions from the AppSync side-channel (ordered array)
    const [toolDescriptions, setToolDescriptions] = useState<string[]>([]);
    const client = useMemo(() => generateClient(), []);

    // Subscribe to AppSync side-channel for AI-rephrased tool action descriptions
    useEffect(() => {
        if (isReadOnly) return;

        const sub = client
            .graphql({
                query: receiveMessages,
                variables: { sessionId },
                authMode: "userPool",
            })
            .subscribe({
                next: (message: any) => {
                    const data = message.data?.receiveMessages?.data;
                    if (!data) return;
                    try {
                        const response: ChatBotMessageResponse = JSON.parse(data);
                        if (response.action === ChatBotAction.ToolAction && response.data.toolAction) {
                            console.log("Voice: AI-rephrased tool description received:", response.data.toolAction);
                            setToolDescriptions((prev) => [...prev, response.data.toolAction!]);
                        }
                    } catch {
                        // ignore parse errors
                    }
                },
                error: (err: any) => console.warn("Voice AppSync side-channel error:", err),
            });

        return () => sub.unsubscribe();
    }, [sessionId, isReadOnly, client]);

    // Build display turns: replace tool turn text with AI-rephrased version if available
    // Match by order: 1st AI description → 1st tool turn, 2nd → 2nd, etc.
    const displayTurns = useMemo(() => {
        const baseTurns = isReadOnly ? restoredTurns : conversationTurns;
        if (!baseTurns || toolDescriptions.length === 0) return baseTurns;

        let toolIdx = 0;
        return baseTurns.map((turn) => {
            if (turn.role === "tool") {
                const aiDescription = toolDescriptions[toolIdx];
                toolIdx++;
                if (aiDescription) {
                    return { ...turn, text: aiDescription };
                }
            }
            return turn;
        });
    }, [isReadOnly, restoredTurns, conversationTurns, toolDescriptions]);

    // Show waveform when someone is actively speaking (activeSpeaker is set)
    // and the session is live (not read-only)
    const showWaveform = !isReadOnly && isRecording && activeSpeaker !== null;

    // All turns to display — including partial (non-final) ones.
    // Text appears gradually as transcripts arrive. No hiding.
    const visibleTurns = displayTurns || [];

    // Auto-scroll when turns change
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [displayTurns]);

    /** End session — stop recording but stay in the view */
    const handleEndSession = () => {
        stopVoice();
        setSessionEnded(true);
        if (conversationTurns.length > 0) {
            onConversationEnd(conversationTurns);
        }
    };

    /** Restart a new conversation */
    const handleRestart = () => {
        setSessionEnded(false);
        startVoice();
    };

    /** Exit back to text chat — fully disconnect */
    const handleExit = () => {
        if (!isReadOnly) {
            stopVoice();
            disconnectVoice();
            if (conversationTurns.length > 0) {
                onConversationEnd(conversationTurns);
            }
        }
        onExit();
    };

    const displayUserName = userName || "You";

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
            {/* ─── Header ─── */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--color-border-divider-default)",
                    flexShrink: 0,
                }}
            >
                <span style={{ fontSize: "18px", fontWeight: 700 }}>
                    🎙 Voice — {agentName}
                </span>
                {isReadOnly && (
                    <StatusIndicator type="info">Read-only</StatusIndicator>
                )}
            </div>

            {/* ─── Error ─── */}
            {error && (
                <Box margin={{ horizontal: "m", top: "s" }}>
                    <Alert type="error" dismissible>{error}</Alert>
                </Box>
            )}

            {/* ─── Conversation Log (scrollable) ─── */}
            <div
                style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "16px",
                }}
            >
                {/* Pre-voice: Start button (only before first recording) */}
                {!isReadOnly && !isRecording && !sessionEnded && visibleTurns.length === 0 && !showWaveform && (
                    <Box textAlign="center" color="text-body-secondary" padding="xl">
                        <SpaceBetween direction="vertical" size="m" alignItems="center">
                            <Box variant="h3">🎙 Ready for Voice</Box>
                            <Box variant="p">Click below to start the conversation.</Box>
                            <Button
                                variant="primary"
                                iconName="microphone"
                                onClick={() => startVoice()}
                            >
                                Start Listening
                            </Button>
                        </SpaceBetween>
                    </Box>
                )}

                {/* Listening but no turns yet */}
                {!isReadOnly && isRecording && visibleTurns.length === 0 && !showWaveform && (
                    <Box textAlign="center" color="text-body-secondary" padding="xl">
                        <SpaceBetween direction="vertical" size="s" alignItems="center">
                            <WaveformAnimation label={`${displayUserName} — speak to begin...`} />
                        </SpaceBetween>
                    </Box>
                )}

                {/* Read-only empty */}
                {isReadOnly && visibleTurns.length === 0 && (
                    <Box textAlign="center" color="text-body-secondary" padding="xl">
                        No conversation recorded for this voice session.
                    </Box>
                )}

                {/* Conversation turns — shown as they arrive (including partial) */}
                <SpaceBetween direction="vertical" size="m">
                    {visibleTurns.map((turn, idx) => (
                        <CompletedTurnCard
                            key={idx}
                            turn={turn}
                            userName={displayUserName}
                            agentName={agentName}
                        />
                    ))}
                </SpaceBetween>

                {/* Active speaker: waveform animation — stays visible until the OTHER actor speaks */}
                {showWaveform && (
                    <div style={{ marginTop: "16px" }}>
                        <WaveformAnimation
                            label={
                                activeSpeaker === "user"
                                    ? `🎤 ${displayUserName} is speaking...`
                                    : activeSpeaker === "tool"
                                        ? `🔧 Agent is using a tool...`
                                        : `🤖 ${agentName} is responding...`
                            }
                        />
                    </div>
                )}

                <div ref={logEndRef} />
            </div>

            {/* ─── Sticky Footer ─── */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderTop: "1px solid var(--color-border-divider-default)",
                    backgroundColor: "var(--color-background-container-content)",
                    flexShrink: 0,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                    {isRecording ? (
                        <StatusIndicator type="success">
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <PulsingDot /> Recording
                            </span>
                        </StatusIndicator>
                    ) : (
                        <StatusIndicator type="stopped">
                            {isReadOnly ? "Session ended" : "Not recording"}
                        </StatusIndicator>
                    )}
                    {isRecording && (
                        <StatusIndicator type={isConnected ? "success" : "loading"}>
                            {isConnected ? "Connected" : "Connecting..."}
                        </StatusIndicator>
                    )}
                </div>

                <SpaceBetween direction="horizontal" size="s">
                    {/* Session ended: Resume */}
                    {sessionEnded && (
                        <Button variant="primary" iconName="microphone" onClick={handleRestart}>
                            Resume Conversation
                        </Button>
                    )}
                    {/* Recording: End Session */}
                    {!sessionEnded && !isReadOnly && isRecording && (
                        <Button variant="primary" iconName="close" onClick={handleEndSession}>
                            End Voice Session
                        </Button>
                    )}
                    {/* Not yet started: just the Start button in the center (no footer button needed) */}
                    {/* Read-only */}
                    {isReadOnly && (
                        <Button variant="primary" iconName="arrow-left" onClick={handleExit}>
                            Back to Chat
                        </Button>
                    )}
                </SpaceBetween>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

/** A completed conversation turn rendered with markdown. */
function CompletedTurnCard({
    turn,
    userName,
    agentName,
}: {
    turn: VoiceConversationTurn;
    userName: string;
    agentName: string;
}) {
    // Tool turns: compact centered pill
    if (turn.role === "tool") {
        return (
            <div style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}>
                <span
                    style={{
                        fontSize: "12px",
                        color: "var(--color-text-body-secondary)",
                        backgroundColor: "var(--color-background-layout-main)",
                        padding: "4px 14px",
                        borderRadius: "12px",
                        border: "1px solid var(--color-border-divider-default)",
                    }}
                >
                    🔧 {turn.text}
                </span>
            </div>
        );
    }

    const isUser = turn.role === "user";
    const icon = isUser ? "🎤" : "🤖";
    const label = isUser ? userName : agentName;
    const isPartial = !turn.isFinal;

    return (
        <div
            style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                opacity: isPartial ? 0.7 : 1,
                transition: "opacity 0.2s ease",
            }}
        >
            <div
                style={{
                    maxWidth: "85%",
                    padding: "10px 16px",
                    borderRadius: "12px",
                    backgroundColor: isUser
                        ? "var(--color-background-input-default)"
                        : "var(--color-background-container-header)",
                    border: `1px solid ${isUser ? "var(--color-border-input-default)" : "var(--color-border-divider-default)"}`,
                }}
            >
                <div
                    style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        marginBottom: "4px",
                        color: "var(--color-text-body-secondary)",
                    }}
                >
                    {icon} {label}
                </div>
                <div style={{ fontSize: "14px", lineHeight: "1.5" }}>
                    <MarkdownContent content={turn.text} />
                </div>
            </div>
        </div>
    );
}

/** Animated waveform with label — shown while someone is actively speaking. */
function WaveformAnimation({ label }: { label: string }) {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
                padding: "16px",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "3px",
                    height: "40px",
                    width: "200px",
                }}
            >
                {Array.from({ length: 20 }, (_, i) => (
                    <span
                        key={i}
                        style={{
                            width: "3px",
                            borderRadius: "2px",
                            backgroundColor: "var(--color-text-accent, #0972d3)",
                            animation: `voice-wave 1.2s ease-in-out ${i * 0.06}s infinite alternate`,
                        }}
                    />
                ))}
            </div>
            <span
                style={{
                    fontSize: "13px",
                    color: "var(--color-text-body-secondary)",
                    fontWeight: 500,
                }}
            >
                {label}
            </span>
            <style>{`
                @keyframes voice-wave {
                    0% { height: 4px; }
                    50% { height: 28px; }
                    100% { height: 6px; }
                }
            `}</style>
        </div>
    );
}

/** Pulsing red dot for recording indicator. */
function PulsingDot() {
    return (
        <span
            style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "#d13212",
                animation: "voice-pulse 1.5s ease-in-out infinite",
            }}
        >
            <style>{`
                @keyframes voice-pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(1.3); }
                }
            `}</style>
        </span>
    );
}
