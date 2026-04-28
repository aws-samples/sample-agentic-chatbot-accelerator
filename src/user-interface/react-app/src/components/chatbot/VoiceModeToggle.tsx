// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Alert, Button, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";
import { useContext, useMemo } from "react";
import { AppContext } from "../../common/app-context";
import { useVoiceAgent, VoiceTranscript } from "../../common/hooks/useVoiceAgent";

interface VoiceModeToggleProps {
    agentRuntimeId: string;
    qualifier: string;
    sessionId: string;
    /** Whether voice is supported for this agent pattern (Single + Agents-as-Tools only) */
    voiceSupported: boolean;
}

/**
 * Voice mode toggle button with real-time transcript display.
 * Shows a microphone button that starts/stops voice conversations.
 * Displays live transcripts from both user (speech-to-text) and assistant (text-to-speech).
 */
export default function VoiceModeToggle({
    agentRuntimeId,
    qualifier,
    sessionId,
    voiceSupported,
}: VoiceModeToggleProps) {
    const appContext = useContext(AppContext);

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
            },
        }),
        [agentRuntimeId, qualifier, sessionId, appContext],
    );

    const { isRecording, isConnected, transcripts, startVoice, stopVoice, error } =
        useVoiceAgent(voiceOptions);

    if (!voiceSupported) {
        return null;
    }

    if (!agentRuntimeId || !appContext) {
        return null;
    }

    return (
        <SpaceBetween direction="vertical" size="s">
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Button
                    variant={isRecording ? "primary" : "normal"}
                    iconName={isRecording ? "close" : "microphone"}
                    onClick={() => (isRecording ? stopVoice() : startVoice())}
                    disabled={!agentRuntimeId}
                >
                    {isRecording ? "Stop Voice" : "🎙 Voice"}
                </Button>
                {isRecording && (
                    <StatusIndicator type={isConnected ? "success" : "loading"}>
                        {isConnected ? "Connected" : "Connecting..."}
                    </StatusIndicator>
                )}
            </SpaceBetween>

            {error && (
                <Alert type="error" dismissible onDismiss={() => {}}>
                    {error}
                </Alert>
            )}

            {isRecording && transcripts.length > 0 && (
                <div
                    style={{
                        maxHeight: "200px",
                        overflowY: "auto",
                        padding: "8px",
                        backgroundColor: "var(--color-background-container-content)",
                        borderRadius: "8px",
                        border: "1px solid var(--color-border-divider-default)",
                    }}
                >
                    {transcripts.map((t: VoiceTranscript, i: number) => (
                        <div
                            key={i}
                            style={{
                                marginBottom: "4px",
                                opacity: t.isFinal ? 1 : 0.6,
                                fontStyle: t.isFinal ? "normal" : "italic",
                            }}
                        >
                            <strong>{t.role === "user" ? "You" : "Agent"}:</strong> {t.text}
                        </div>
                    ))}
                </div>
            )}
        </SpaceBetween>
    );
}
