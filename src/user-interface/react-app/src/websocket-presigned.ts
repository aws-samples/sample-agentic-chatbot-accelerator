// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Module: WebSocket Presigned URL + Connection Manager
//
// Creates SigV4 presigned WebSocket URLs for direct browser-to-AgentCore
// connections, bypassing the AppSync/SNS pipeline for lower latency.
//
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";

import { getAWSCredentials } from "./aws-credentials";

// ------------------------------------------------------------------ //
//  Types
// ------------------------------------------------------------------ //

export interface WebSocketAgentConnection {
    send: (message: unknown) => void;
    close: () => void;
    isConnected: () => boolean;
    sessionId: string;
}

export interface ConnectOptions {
    /** AgentCore runtime ID (e.g. "my_agent-abc123") — will be converted to full ARN */
    agentRuntimeId: string;
    /** AWS Account ID for constructing the runtime ARN */
    accountId: string;
    /** Qualifier / endpoint name (e.g. "DEFAULT") */
    qualifier: string;
    /** Connection mode — "text" for `/ws`, "voice" for `/ws/voice` */
    mode: "text" | "voice";
    /** App configuration with region + Cognito IDs */
    config: {
        aws_project_region: string;
        aws_user_pools_id: string;
        aws_cognito_identity_pool_id: string;
    };

    // --- Text mode callbacks ---
    onTextToken?: (data: string, sequenceNumber: number, runId?: string) => void;
    onFinalResponse?: (response: FinalResponsePayload) => void;
    onToolAction?: (toolName: string, description: string, invocationNumber: number) => void;

    // --- Voice mode callbacks ---
    onAudioChunk?: (audio: string, format: string, sampleRate: number) => void;
    onTranscript?: (text: string, isFinal: boolean, role: "assistant" | "user") => void;
    onInterruption?: (reason: string) => void;

    // --- Common callbacks ---
    onError?: (error: string) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;

    sessionId?: string;
}

export interface FinalResponsePayload {
    type: "final_response";
    content: string;
    sessionId: string;
    messageId: string;
    references?: string;
    reasoningContent?: string;
    structuredOutput?: string;
}

// ------------------------------------------------------------------ //
//  Internal: create SigV4 presigned URL
// ------------------------------------------------------------------ //

async function createPresignedUrl(
    agentRuntimeArn: string,
    qualifier: string,
    sessionId: string,
    _mode: "text" | "voice",
    config: ConnectOptions["config"],
): Promise<string> {
    const region = config.aws_project_region;
    const credentials = await getAWSCredentials(config);

    // AgentCore only supports the /ws path — voice/text mode is
    // determined by the first message sent after connection
    const wsPath = "ws";
    // URL format per AWS docs: wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<agentRuntimeArn>/ws
    // The ARN must be URI-encoded in the path
    const encodedArn = encodeURIComponent(agentRuntimeArn);
    const baseUrl = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/${wsPath}`;
    const url = new URL(baseUrl);

    url.searchParams.set("qualifier", qualifier);
    url.searchParams.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", sessionId);

    const request = new HttpRequest({
        method: "GET",
        protocol: "https:",
        hostname: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { host: url.hostname },
    });

    const signer = new SignatureV4({
        service: "bedrock-agentcore",
        region,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
        },
        sha256: Sha256,
    });

    const signed = await signer.presign(request, { expiresIn: 3600 });

    const queryString = Object.entries(signed.query || {})
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");

    return `wss://${signed.hostname}${signed.path}${queryString ? "?" + queryString : ""}`;
}

// ------------------------------------------------------------------ //
//  Public: connect to AgentCore via presigned WebSocket
// ------------------------------------------------------------------ //

/**
 * Establish a direct WebSocket connection to an AgentCore runtime.
 *
 * The connection is authenticated via SigV4 presigned URL using temporary
 * AWS credentials from the Cognito Identity Pool.
 */
export async function connectToAgent(options: ConnectOptions): Promise<WebSocketAgentConnection> {
    const sessionId = options.sessionId || crypto.randomUUID();
    // Construct full ARN from runtime ID + account ID + region
    const region = options.config.aws_project_region;
    const agentRuntimeArn = `arn:aws:bedrock-agentcore:${region}:${options.accountId}:runtime/${options.agentRuntimeId}`;

    const presignedUrl = await createPresignedUrl(
        agentRuntimeArn,
        options.qualifier,
        sessionId,
        options.mode,
        options.config,
    );

    const ws = new WebSocket(presignedUrl);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("WebSocket connection timed out after 15s"));
        }, 15_000);

        ws.onopen = () => {
            clearTimeout(timeout);
            options.onConnected?.();
            resolve({
                send: (msg: unknown) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(msg));
                    }
                },
                close: () => ws.close(),
                isConnected: () => ws.readyState === WebSocket.OPEN,
                sessionId,
            });
        };

        ws.onerror = () => {
            clearTimeout(timeout);
            options.onError?.("WebSocket connection failed");
            reject(new Error("WebSocket connection failed"));
        };

        ws.onclose = () => {
            clearTimeout(timeout);
            options.onDisconnected?.();
        };

        ws.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data as string);

                switch (data.type) {
                    // --- Text mode events ---
                    case "text_token":
                        options.onTextToken?.(data.data, data.sequenceNumber, data.runId);
                        break;
                    case "final_response":
                        options.onFinalResponse?.(data as FinalResponsePayload);
                        break;
                    case "tool_action":
                        options.onToolAction?.(
                            data.toolName,
                            data.description,
                            data.invocationNumber,
                        );
                        break;

                    // --- Voice mode events ---
                    case "bidi_audio_stream":
                        options.onAudioChunk?.(
                            data.audio,
                            data.format || "pcm",
                            data.sample_rate || 16000,
                        );
                        break;
                    case "bidi_transcript_stream":
                        options.onTranscript?.(
                            data.text || "",
                            data.is_final !== false,
                            data.role === "user" ? "user" : "assistant",
                        );
                        break;
                    case "bidi_text_response":
                        options.onTranscript?.(data.text, true, "assistant");
                        break;
                    case "bidi_interruption":
                        options.onInterruption?.(data.reason || "interrupted");
                        break;

                    // --- Voice: tool stream events (informational) ---
                    case "tool_use_stream":
                    case "tool_result":
                    case "tool_result_message":
                    case "tool_stream":
                        // Tool events during voice mode — logged but not displayed
                        console.debug("Voice tool event:", data.type, data);
                        break;

                    // --- Common ---
                    case "heartbeat_ack":
                        // Heartbeat acknowledged — no action needed
                        break;
                    case "error":
                        options.onError?.(data.message);
                        break;

                    default:
                        console.debug("Unhandled WebSocket message type:", data.type);
                }
            } catch (err) {
                console.error("Error parsing WebSocket message:", err);
            }
        };
    });
}
