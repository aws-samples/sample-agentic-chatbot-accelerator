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
import { Alert, Box, Button, FormField, Select, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../../common/app-context";
import { useVoiceAgent, VoiceConversationTurn } from "../../common/hooks/useVoiceAgent";
import { getDefaultRuntimeConfiguration as getDefaultRuntimeConfigurationQuery } from "../../graphql/queries";
import { ConnectOptions } from "../../websocket-presigned";
import { AgentOption, EndpointOption } from "./types";
import { maskSensitiveInfo } from "./utils";
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

    // Agent/Endpoint selector props (from lifted state in chat.tsx)
    availableAgents: AgentOption[];
    availableEndpoints: EndpointOption[];
    agentsLoading: boolean;
    endpointsLoading: boolean;
    /** Called when user changes agent — parent decides whether to stay in voice or exit */
    onAgentChange: (newAgentId: string, newQualifier: string, isSonic: boolean) => void;
}

export default function VoiceConversationView({
    agentRuntimeId,
    qualifier,
    sessionId,
    agentName,
    userName,
    onExit: _onExit,
    onConversationEnd,
    restoredTurns,
    availableAgents,
    availableEndpoints,
    agentsLoading,
    endpointsLoading,
    onAgentChange,
}: VoiceConversationViewProps) {
    const appContext = useContext(AppContext);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [isReadOnly, setIsReadOnly] = useState(!!restoredTurns);
    const [sessionEnded, setSessionEnded] = useState(false);
    /** True while startVoice() is connecting after a resume — prevents "Start Listening" flash */
    const [resuming, setResuming] = useState(false);

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

    const { isRecording, isConnected, conversationTurns, activeSpeaker, startVoice, stopVoice, disconnectVoice: _disconnectVoice, error } =
        useVoiceAgent(voiceOptions);

    const client = useMemo(() => generateClient(), []);

    // Helper: filter out context-replay artifacts from new turns after a resume.
    // When the agent reconnects on resume, it may replay tool events from its context
    // before the user speaks again. These are not real new interactions — drop them.
    const filterReplayArtifacts = (newTurns: VoiceConversationTurn[]): VoiceConversationTurn[] => {
        if (!restoredTurns || restoredTurns.length === 0 || newTurns.length === 0) {
            return newTurns;
        }
        // Skip any non-user turns at the start of newTurns (they are replay artifacts)
        let startIdx = 0;
        while (startIdx < newTurns.length && newTurns[startIdx].role !== "user") {
            startIdx++;
        }
        return newTurns.slice(startIdx);
    };

    // Build display turns:
    // - Read-only: show restored turns only
    // - Resumed (was read-only, now live): show restored turns + new live turns (filtered)
    // - Fresh session: show live conversation turns only
    // Tool descriptions are applied to tool turns by useVoiceAgent (raw WS path),
    // so no further overlay is needed here.
    const displayTurns = useMemo(() => {
        if (isReadOnly) {
            return restoredTurns || [];
        }
        if (restoredTurns && restoredTurns.length > 0) {
            // Resumed session: combine old + new (filtered to remove replay artifacts)
            return [...restoredTurns, ...filterReplayArtifacts(conversationTurns)];
        }
        return conversationTurns;
    }, [isReadOnly, restoredTurns, conversationTurns]);

    // Show waveform when someone is actively speaking (activeSpeaker is set)
    // and the session is live (not read-only)
    const showWaveform = !isReadOnly && isRecording && activeSpeaker !== null;

    // All turns to display — including partial (non-final) ones.
    // Text appears gradually as transcripts arrive. No hiding.
    const visibleTurns = displayTurns || [];

    // Clear resuming flag once recording actually starts
    useEffect(() => {
        if (isRecording && resuming) {
            setResuming(false);
        }
    }, [isRecording, resuming]);

    // Auto-scroll when turns change
    useEffect(() => {
        const container = scrollContainerRef.current;
        if (container) {
            container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        }
    }, [displayTurns]);

    /** Combine restored turns (if any) with new live turns for a complete transcript.
     *  Uses filterReplayArtifacts to strip context-replay tool events that fire
     *  before the user speaks again after a resume. */
    const getAllTurns = () => {
        const filteredNew = filterReplayArtifacts(conversationTurns);
        return [...(restoredTurns || []), ...filteredNew];
    };

    /** End session — stop recording but stay in the view */
    const handleEndSession = () => {
        stopVoice();
        setSessionEnded(true);
        const allTurns = getAllTurns();
        if (allTurns.length > 0) {
            onConversationEnd(allTurns);
        }
    };

    /** Restart a new conversation */
    const handleRestart = () => {
        setSessionEnded(false);
        startVoice();
    };


    // ================================================================
    // Agent change handler — check if new agent is sonic before calling parent
    // ================================================================
    const handleAgentSelect = async (newAgentId: string) => {
        if (newAgentId === agentRuntimeId) return;

        const selectedAgent = availableAgents.find((a) => a.value === newAgentId);
        if (!selectedAgent) return;

        // Check architectureType first
        const arch = selectedAgent.architectureType;
        if (arch && arch !== "SINGLE" && arch !== "AGENTS_AS_TOOLS") {
            // Definitely not sonic-capable — exit voice
            onAgentChange(newAgentId, "DEFAULT", false);
            return;
        }

        // Check model to determine if sonic
        let isSonic = false;
        try {
            const result = await client.graphql({
                query: getDefaultRuntimeConfigurationQuery,
                variables: { agentName: selectedAgent.label },
            });
            const config = JSON.parse((result as any).data.getDefaultRuntimeConfiguration);
            const modelId = config?.modelInferenceParameters?.modelId || "";
            isSonic = modelId.toLowerCase().includes("sonic");
        } catch {
            // If can't load config, assume not sonic for safety
            isSonic = false;
        }

        // Use DEFAULT qualifier for new agent — parent will load proper endpoints
        onAgentChange(newAgentId, "DEFAULT", isSonic);
    };

    const handleEndpointSelect = (newQualifier: string) => {
        if (newQualifier === qualifier) return;
        // Endpoint change within same agent — always stays in voice (agent is already sonic)
        onAgentChange(agentRuntimeId, newQualifier, true);
    };

    const displayUserName = userName || "You";

    // Dropdowns are disabled while recording (can only change when paused/before start)
    const dropdownsDisabled = isRecording || isReadOnly;

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
            {/* ─── Header ─── */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--color-border-divider-default)",
                    flexShrink: 0,
                    flexWrap: "wrap",
                    gap: "8px",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "18px", fontWeight: 700 }}>
                        🎙 Voice
                    </span>
                </div>

                {/* Agent/Endpoint Selectors */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    {!agentsLoading && availableAgents.length > 0 && (
                        <>
                            <div style={{ minWidth: "160px" }}>
                                <FormField label="Agent Runtime">
                                    <Select
                                        disabled={dropdownsDisabled || agentsLoading}
                                        placeholder={agentsLoading ? "Loading..." : "Select agent"}
                                        selectedOption={
                                            agentRuntimeId
                                                ? availableAgents.find((a) => a.value === agentRuntimeId) || null
                                                : null
                                        }
                                        onChange={({ detail }) => {
                                            const newId = detail.selectedOption?.value || "";
                                            if (newId) handleAgentSelect(newId);
                                        }}
                                        options={availableAgents}
                                        statusType={agentsLoading ? "loading" : "finished"}
                                        loadingText="Loading..."
                                    />
                                </FormField>
                            </div>

                            <div style={{ minWidth: "140px" }}>
                                <FormField label="Endpoint">
                                    <Select
                                        disabled={dropdownsDisabled || !agentRuntimeId || endpointsLoading}
                                        placeholder={endpointsLoading ? "Loading..." : "Endpoint"}
                                        selectedOption={
                                            qualifier
                                                ? availableEndpoints.find((e) => e.value === qualifier) || null
                                                : null
                                        }
                                        onChange={({ detail }) => {
                                            const newQ = detail.selectedOption?.value || "DEFAULT";
                                            handleEndpointSelect(newQ);
                                        }}
                                        options={availableEndpoints}
                                        statusType={endpointsLoading ? "loading" : "finished"}
                                        loadingText="Loading..."
                                    />
                                </FormField>
                            </div>
                        </>
                    )}
                </div>

            </div>

            {/* ─── Error ─── */}
            {error && (
                <Box margin={{ horizontal: "m", top: "s" }}>
                    <Alert type="error" dismissible>{error}</Alert>
                </Box>
            )}

            {/* ─── Conversation Log (scrollable) ─── */}
            <div
                ref={scrollContainerRef}
                style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    padding: "16px",
                }}
            >
                {/* Pre-voice: Start button (only before first recording, not during resume) */}
                {!isReadOnly && !isRecording && !sessionEnded && !resuming && visibleTurns.length === 0 && !showWaveform && (
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
                    {/* Read-only: Resume */}
                    {isReadOnly && (
                        <Button variant="primary" iconName="microphone" onClick={() => {
                            setResuming(true);
                            setIsReadOnly(false);
                            startVoice();
                        }}>
                            Resume Conversation
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
    // Tool turns: compact centered pill, expandable to reveal the agent's arguments
    if (turn.role === "tool") {
        return <ToolTurnPill turn={turn} />;
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

/** A tool-use turn rendered as a centered pill. Click to expand the agent's
 *  arguments (name/value pairs), mirroring the text chat's tool-step display. */
function ToolTurnPill({ turn }: { turn: VoiceConversationTurn }) {
    const [expanded, setExpanded] = useState(false);
    const hasParams = !!turn.parameters && turn.parameters.length > 0;

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 0", gap: "4px" }}>
            <span
                role={hasParams ? "button" : undefined}
                tabIndex={hasParams ? 0 : undefined}
                onClick={hasParams ? () => setExpanded((e) => !e) : undefined}
                onKeyDown={
                    hasParams
                        ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setExpanded((prev) => !prev);
                              }
                          }
                        : undefined
                }
                style={{
                    fontSize: "12px",
                    color: "var(--color-text-body-secondary)",
                    backgroundColor: "var(--color-background-layout-main)",
                    padding: "4px 14px",
                    borderRadius: "12px",
                    border: "1px solid var(--color-border-divider-default)",
                    cursor: hasParams ? "pointer" : "default",
                    userSelect: "none",
                }}
            >
                🔧 {turn.text}
                {hasParams && <span style={{ marginLeft: "6px" }}>{expanded ? "▼" : "▶"}</span>}
            </span>
            {hasParams && expanded && (
                <ul
                    style={{
                        margin: 0,
                        padding: "4px 12px",
                        listStyleType: "circle",
                        fontSize: "11px",
                        color: "var(--color-text-body-secondary)",
                        maxWidth: "85%",
                    }}
                >
                    {turn.parameters!.map((p) => (
                        <li key={p.name} style={{ wordBreak: "break-word" }}>
                            <span style={{ fontWeight: 600 }}>{p.name}:</span> {maskSensitiveInfo(p.value)}
                        </li>
                    ))}
                </ul>
            )}
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
