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
import { connectToAgent, ConnectOptions, WebSocketAgentConnection } from "../../websocket-presigned";

export interface VoiceTranscript {
    role: "user" | "assistant";
    text: string;
    isFinal: boolean;
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
    transcripts: VoiceTranscript[];
    startVoice: () => Promise<void>;
    stopVoice: () => void;
    error: string | null;
}

/**
 * Custom hook for bidirectional voice streaming with AgentCore.
 *
 * Captures microphone audio via AudioWorklet, encodes to base64 PCM,
 * sends to AgentCore via WebSocket, receives audio responses,
 * and plays them back via AudioContext.
 */
export function useVoiceAgent(options: UseVoiceAgentOptions): UseVoiceAgentReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [transcripts, setTranscripts] = useState<VoiceTranscript[]>([]);
    const [error, setError] = useState<string | null>(null);

    const connectionRef = useRef<WebSocketAgentConnection | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const workletNodeRef = useRef<AudioWorkletNode | null>(null);
    const playbackContextRef = useRef<AudioContext | null>(null);
    const audioQueueRef = useRef<Float32Array[]>([]);
    const isPlayingRef = useRef(false);

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

    // Play audio from the queue
    const playNextAudio = useCallback(async () => {
        if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
        isPlayingRef.current = true;

        if (!playbackContextRef.current) {
            playbackContextRef.current = new AudioContext({ sampleRate: 16000 });
        }

        while (audioQueueRef.current.length > 0) {
            const samples = audioQueueRef.current.shift()!;
            const buffer = playbackContextRef.current.createBuffer(1, samples.length, 16000);
            buffer.getChannelData(0).set(samples);

            const source = playbackContextRef.current.createBufferSource();
            source.buffer = buffer;
            source.connect(playbackContextRef.current.destination);

            await new Promise<void>((resolve) => {
                source.onended = () => resolve();
                source.start();
            });
        }

        isPlayingRef.current = false;
    }, []);

    // Start voice recording and WebSocket connection
    const startVoice = useCallback(async () => {
        try {
            setError(null);
            setTranscripts([]);

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

            // Set up AudioContext and Worklet
            const audioContext = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = audioContext;

            await audioContext.audioWorklet.addModule("/audio-processor.worklet.js");
            const workletNode = new AudioWorkletNode(audioContext, "audio-capture-processor");
            workletNodeRef.current = workletNode;

            const source = audioContext.createMediaStreamSource(stream);
            source.connect(workletNode);

            // Connect to AgentCore via WebSocket (voice mode)
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
                    setTranscripts((prev) => {
                        // Update last transcript of same role if not final, otherwise add new
                        const lastIdx = prev.length - 1;
                        if (lastIdx >= 0 && prev[lastIdx].role === role && !prev[lastIdx].isFinal) {
                            const updated = [...prev];
                            updated[lastIdx] = { role, text, isFinal };
                            return updated;
                        }
                        return [...prev, { role, text, isFinal }];
                    });
                },

                onInterruption: (reason: string) => {
                    console.log("Voice interruption:", reason);
                    // Clear audio queue on interruption (barge-in)
                    audioQueueRef.current = [];
                    isPlayingRef.current = false;
                },

                onError: (errorMessage: string) => {
                    console.error("Voice WebSocket error:", errorMessage);
                    setError(errorMessage);
                },
            });

            connectionRef.current = conn;

            // Tell the container to switch to voice (BidiAgent) mode
            conn.send({ type: "voice_init" });

            // Send audio chunks from worklet to WebSocket
            workletNode.port.onmessage = (event) => {
                if (event.data.type === "audio" && conn.isConnected()) {
                    const base64Audio = int16ToBase64(event.data.data);
                    conn.send({
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

    // Stop voice recording
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

        // Close audio contexts
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        // Send close event and disconnect WebSocket
        if (connectionRef.current?.isConnected()) {
            connectionRef.current.send({ type: "bidi_close", reason: "user_request" });
            connectionRef.current.close();
        }
        connectionRef.current = null;

        // Clear audio queue
        audioQueueRef.current = [];
        isPlayingRef.current = false;

        setIsRecording(false);
        setIsConnected(false);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopVoice();
        };
    }, [stopVoice]);

    return {
        isRecording,
        isConnected,
        transcripts,
        startVoice,
        stopVoice,
        error,
    };
}
