// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useVoiceAgent
//
// Manages bidirectional voice streaming with an AgentCore runtime
// via WebSocket. Handles microphone capture, audio encoding,
// WebSocket communication, audio playback, and transcript display.
//
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUserAttributes } from "aws-amplify/auth";
import { connectToAgent, ConnectOptions, WebSocketAgentConnection } from "../../websocket-presigned";

/** A single turn in a voice conversation (user speech, assistant speech, or tool use). */
export interface VoiceConversationTurn {
    role: "user" | "assistant" | "tool";
    text: string;
    timestamp: number;
    isFinal: boolean;
    toolName?: string;
}

export interface UseVoiceAgentOptions {
    agentRuntimeId: string;
    accountId: string;
    qualifier: string;
    sessionId: string;
    config: ConnectOptions["config"];
}

export interface UseVoiceAgentReturn {
    isRecording: boolean;
    isConnected: boolean;
    /** All conversation turns (transcripts + tool events) in chronological order */
    conversationTurns: VoiceConversationTurn[];
    /** Who is currently speaking — stays set until the OTHER actor starts speaking */
    activeSpeaker: "user" | "assistant" | "tool" | null;
    startVoice: () => Promise<void>;
    /** Pause: stop mic/audio but keep WS alive for context */
    stopVoice: () => void;
    /** Full disconnect: close WS, save session (use on exit/unmount) */
    disconnectVoice: () => void;
    error: string | null;
}

/**
 * Custom hook for bidirectional voice streaming with AgentCore.
 *
 * Captures microphone audio via AudioWorklet, encodes to base64 PCM,
 * sends to AgentCore via WebSocket, receives audio responses,
 * and plays them back via AudioContext.
 *
 * Accumulates all conversation turns (user transcripts, assistant transcripts,
 * and tool use events) for display in VoiceConversationView.
 */
export function useVoiceAgent(options: UseVoiceAgentOptions): UseVoiceAgentReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [conversationTurns, setConversationTurns] = useState<VoiceConversationTurn[]>([]);
    const [activeSpeaker, setActiveSpeaker] = useState<"user" | "assistant" | "tool" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const connectionRef = useRef<WebSocketAgentConnection | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const workletNodeRef = useRef<AudioWorkletNode | null>(null);
    const playbackContextRef = useRef<AudioContext | null>(null);
    const audioQueueRef = useRef<Float32Array[]>([]);
    const isPlayingRef = useRef(false);
    /** Tracks the next time (in AudioContext seconds) to schedule the next chunk */
    const nextPlayTimeRef = useRef(0);
    /** Timer to detect when audio playback has fully drained */
    const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Keep a ref to conversationTurns so stopVoice can access latest value
    const conversationTurnsRef = useRef<VoiceConversationTurn[]>([]);
    conversationTurnsRef.current = conversationTurns;

    // Convert Int16 PCM buffer to base64 string
    const int16ToBase64 = useCallback((buffer: Int16Array): string => {
        const bytes = new Uint8Array(buffer.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }, []);

    // Convert base64 PCM to Float32 for playback
    const base64ToFloat32 = useCallback((base64: string): Float32Array => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }
        return float32;
    }, []);

    // Play audio from the queue using schedule-ahead playback.
    // Instead of awaiting each chunk sequentially (which introduces micro-gaps
    // causing robotic/choppy audio), we schedule all queued chunks at precise
    // future times using AudioContext.currentTime. This produces gapless playback.
    const playNextAudio = useCallback(async () => {
        if (audioQueueRef.current.length === 0) return;

        // Playback AudioContext is created in startVoice() inside user gesture.
        // Fallback creation here for safety, but prefer user-gesture init.
        if (!playbackContextRef.current) {
            playbackContextRef.current = new AudioContext({ sampleRate: 16000 });
        }
        // Resume if suspended (browsers may suspend AudioContext not from user gesture)
        if (playbackContextRef.current.state === "suspended") {
            await playbackContextRef.current.resume();
        }

        const ctx = playbackContextRef.current;
        const sampleRate = 16000;

        // If our scheduled time is in the past, reset to now (+ small lookahead buffer)
        if (nextPlayTimeRef.current < ctx.currentTime) {
            nextPlayTimeRef.current = ctx.currentTime + 0.01; // 10ms lookahead
        }

        // Schedule all currently queued chunks back-to-back
        while (audioQueueRef.current.length > 0) {
            const samples = audioQueueRef.current.shift()!;
            const buffer = ctx.createBuffer(1, samples.length, sampleRate);
            buffer.getChannelData(0).set(samples);

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(nextPlayTimeRef.current);

            // Advance the schedule time by this chunk's duration
            nextPlayTimeRef.current += samples.length / sampleRate;
        }

        // Set up a drain timer: fires after all scheduled audio has finished + 500ms grace.
        // This detects when the assistant response is complete (Nova Sonic doesn't emit
        // bidi_response_complete to custom output adapters).
        if (drainTimerRef.current) {
            clearTimeout(drainTimerRef.current);
        }
        const remainingMs = Math.max(0, (nextPlayTimeRef.current - ctx.currentTime) * 1000);
        drainTimerRef.current = setTimeout(() => {
            // Only reveal text if no new audio arrived in the meantime
            if (audioQueueRef.current.length === 0) {
                setActiveSpeaker((current) => {
                    if (current === "assistant") return null;
                    return current;
                });
            }
        }, remainingMs + 500);
    }, []);

    // Start voice recording and WebSocket connection (or resume if WS still alive)
    const startVoice = useCallback(async () => {
        try {
            setError(null);

            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });
            mediaStreamRef.current = stream;

            // Create playback AudioContext early (inside user gesture) to avoid
            // browser restrictions that cause degraded/robotic audio quality
            if (!playbackContextRef.current) {
                playbackContextRef.current = new AudioContext({ sampleRate: 16000 });
            }

            // Set up AudioContext and Worklet for capture
            const audioContext = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = audioContext;

            await audioContext.audioWorklet.addModule("/audio-processor.worklet.js");
            const workletNode = new AudioWorkletNode(audioContext, "audio-capture-processor");
            workletNodeRef.current = workletNode;

            const source = audioContext.createMediaStreamSource(stream);
            source.connect(workletNode);

            // If WebSocket is still alive (resume after pause), just re-attach mic
            if (connectionRef.current?.isConnected()) {
                console.log("Voice: resuming — reusing existing WebSocket connection");
                workletNode.port.onmessage = (event) => {
                    if (event.data.type === "audio" && connectionRef.current?.isConnected()) {
                        const base64Audio = int16ToBase64(event.data.data);
                        connectionRef.current.send({
                            type: "bidi_audio_input",
                            audio: base64Audio,
                            format: "pcm",
                            sample_rate: 16000,
                            channels: 1,
                        });
                    }
                };
                setIsRecording(true);
                return;
            }

            // New connection — connect to AgentCore via WebSocket (voice mode)
            const conn = await connectToAgent({
                agentRuntimeId: options.agentRuntimeId,
                accountId: options.accountId,
                qualifier: options.qualifier,
                mode: "voice",
                config: options.config,
                sessionId: options.sessionId,

                onConnected: () => {
                    setIsConnected(true);
                    console.log("Voice WebSocket connected");
                },

                onDisconnected: () => {
                    setIsConnected(false);
                    console.log("Voice WebSocket disconnected");
                },

                onAudioChunk: (audio: string, _format: string, _sampleRate: number) => {
                    // Decode and queue audio for playback
                    const float32 = base64ToFloat32(audio);
                    audioQueueRef.current.push(float32);
                    playNextAudio();
                },

                onTranscript: (text: string, isFinal: boolean, role: "user" | "assistant") => {
                    // Track who is currently speaking — waveform stays until the OTHER actor speaks
                    setActiveSpeaker(role);

                    setConversationTurns((prev) => {
                        const lastIdx = prev.length - 1;
                        const lastTurn = lastIdx >= 0 ? prev[lastIdx] : null;

                        // Same role as last turn → accumulate
                        if (lastTurn && lastTurn.role === role) {
                            const updated = [...prev];
                            if (role === "user") {
                                if (!lastTurn.isFinal) {
                                    // Still in the same utterance (partial updates are cumulative)
                                    // → replace in place
                                    updated[lastIdx] = { role, text, isFinal, timestamp: Date.now() };
                                } else {
                                    // Previous user turn was final — this is a NEW utterance after a pause
                                    // → append to preserve the earlier text
                                    updated[lastIdx] = {
                                        ...updated[lastIdx],
                                        text: updated[lastIdx].text + " " + text,
                                        isFinal,
                                        timestamp: Date.now(),
                                    };
                                }
                            } else {
                                // Assistant transcripts are INCREMENTAL (each chunk is new words)
                                // → always append
                                updated[lastIdx] = {
                                    ...updated[lastIdx],
                                    text: updated[lastIdx].text + " " + text,
                                    isFinal,
                                    timestamp: Date.now(),
                                };
                            }
                            return updated;
                        }

                        // Different role or first turn → add new entry
                        return [
                            ...prev,
                            { role, text, isFinal, timestamp: Date.now() },
                        ];
                    });
                },

                onToolEvent: (toolName: string, eventType: string, description?: string) => {
                    // Track tool as active speaker (shows waveform with tool label)
                    setActiveSpeaker("tool");

                    if (eventType === "tool_use_stream") {
                        // New tool invocation — show clean placeholder
                        const cleanName = toolName
                            .replace(/^[a-z-]+_aws___/, "") // strip MCP prefixes
                            .replace(/_/g, " ");
                        const toolText = `Using ${cleanName}...`;
                        setConversationTurns((prev) => [
                            ...prev,
                            {
                                role: "tool" as const,
                                text: toolText,
                                toolName,
                                isFinal: true,
                                timestamp: Date.now(),
                            },
                        ]);
                    } else if (eventType === "tool_description" && description) {
                        // AI-rephrased description arrived — update the LAST tool turn's text
                        setConversationTurns((prev) => {
                            // Find the last tool turn and replace its text
                            const updated = [...prev];
                            for (let i = updated.length - 1; i >= 0; i--) {
                                if (updated[i].role === "tool") {
                                    updated[i] = { ...updated[i], text: description };
                                    break;
                                }
                            }
                            return updated;
                        });
                    }
                },

                onResponseComplete: (stopReason: string) => {
                    console.log("Voice: onResponseComplete fired, stopReason:", stopReason);
                    // Agent finished its response — reveal the text by clearing activeSpeaker
                    // This shows the assistant's text bubble (same as when the other actor speaks)
                    setActiveSpeaker(null);
                },

                onInterruption: (reason: string) => {
                    console.log("Voice interruption:", reason);
                    // Clear audio queue
                    audioQueueRef.current = [];
                    nextPlayTimeRef.current = 0;
                    if (drainTimerRef.current) {
                        clearTimeout(drainTimerRef.current);
                        drainTimerRef.current = null;
                    }
                    // STOP already-scheduled audio immediately by closing the playback context.
                    // (With schedule-ahead, chunks are pre-scheduled in the AudioContext timeline —
                    // clearing the queue alone won't stop them. Closing the context cancels all.)
                    if (playbackContextRef.current) {
                        playbackContextRef.current.close();
                        playbackContextRef.current = null;
                    }
                },

                onError: (errorMessage: string) => {
                    console.error("Voice WebSocket error:", errorMessage);
                    setError(errorMessage);
                },
            });

            connectionRef.current = conn;

            // Get Cognito user ID for session memory persistence
            let userId = "voice-user";
            try {
                const attrs = await fetchUserAttributes();
                userId = attrs.sub || "voice-user";
            } catch {
                console.warn("Could not fetch user attributes for voice userId");
            }

            // Tell the container to switch to voice (BidiAgent) mode
            // Include sessionId and userId so the container can set up memory correctly
            conn.send({ type: "voice_init", sessionId: options.sessionId, userId });

            // Send audio chunks from worklet to WebSocket
            workletNode.port.onmessage = (event) => {
                if (event.data.type === "audio" && connectionRef.current?.isConnected()) {
                    const base64Audio = int16ToBase64(event.data.data);
                    connectionRef.current.send({
                        type: "bidi_audio_input",
                        audio: base64Audio,
                        format: "pcm",
                        sample_rate: 16000,
                        channels: 1,
                    });
                }
            };

            setIsRecording(true);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to start voice";
            setError(message);
            console.error("Failed to start voice:", err);
        }
    }, [options, int16ToBase64, base64ToFloat32, playNextAudio]);

    // Pause voice — stop mic/audio but keep WebSocket alive for context preservation
    const stopVoice = useCallback(() => {
        // Stop microphone
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop());
            mediaStreamRef.current = null;
        }

        // Disconnect worklet
        if (workletNodeRef.current) {
            workletNodeRef.current.disconnect();
            workletNodeRef.current = null;
        }

        // Close audio contexts (both capture and playback — stops any playing audio immediately)
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        if (playbackContextRef.current) {
            playbackContextRef.current.close();
            playbackContextRef.current = null;
        }

        // Clear audio queue and scheduled playback state
        audioQueueRef.current = [];
        isPlayingRef.current = false;
        nextPlayTimeRef.current = 0;
        if (drainTimerRef.current) {
            clearTimeout(drainTimerRef.current);
            drainTimerRef.current = null;
        }

        // NOTE: WebSocket is intentionally kept alive so the BidiAgent retains
        // conversation context for when the user resumes.

        setIsRecording(false);
        setActiveSpeaker(null);
    }, []);

    // Fully disconnect — close WebSocket and save session (called on unmount / exit)
    const disconnectVoice = useCallback(() => {
        // Save voice session to DynamoDB via container, then close WebSocket
        if (connectionRef.current?.isConnected()) {
            const finalTurns = conversationTurnsRef.current
                .filter((t) => t.isFinal)
                .map((t) => ({ role: t.role, text: t.text }));

            if (finalTurns.length > 0) {
                connectionRef.current.send({
                    type: "voice_save",
                    sessionId: options.sessionId,
                    agentRuntimeId: options.agentRuntimeId,
                    qualifier: options.qualifier,
                    turns: finalTurns,
                });
            }

            connectionRef.current.send({ type: "bidi_close", reason: "user_request" });
            connectionRef.current.close();
        }
        connectionRef.current = null;
        setIsConnected(false);
    }, [options.sessionId, options.agentRuntimeId, options.qualifier]);

    // Cleanup on unmount — fully disconnect
    useEffect(() => {
        return () => {
            stopVoice();
            disconnectVoice();
        };
    }, [stopVoice, disconnectVoice]);

    return {
        isRecording,
        isConnected,
        conversationTurns,
        activeSpeaker,
        startVoice,
        stopVoice,
        disconnectVoice,
        error,
    };
}
