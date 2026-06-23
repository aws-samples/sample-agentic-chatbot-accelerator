/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
// ---------------------------- Enums --------------------------------
export enum ChatBotMessageType {
    AI = "assistant",
    Human = "user",
}

export enum ChatBotAction {
    Heartbeat = "heartbeat",
    Run = "run",
    FinalResponse = "final_response",
    Error = "error",
    LLMNewToken = "on_new_llm_token",
    ToolAction = "tool_action",
}

export enum IngestionJobStatus {
    Checking = "checking",
    InProgress = "in_progress",
    Ready = "ready",
    Broken = "broken",
}

export enum Framework {
    BEDROCK_MANAGED = "BEDROCK_MANAGED", // unused - legacy code
    STRANDS = "STRANDS", // unused - legacy code
    AGENT_CORE = "AGENT_CORE",
}

// -------------------------- Interfaces -----------------------------
export interface LLMToken {
    sequenceNumber: number;
    runId?: string;
    value: string;
}

export interface Feedback {
    sentiment: string;
    notes: string;
    // harmful?: boolean;
    // incomplete?: boolean;
    // inaccurate?: boolean;
    // other?: boolean;
}

export interface ToolParameter {
    name: string;
    // Display-ready value: the backend JSON-encodes non-strings and truncates
    // long values to a preview before sending.
    value: string;
}

export interface ToolActionItem {
    toolAction: string;
    toolName: string;
    invocationNumber: number;
    // Argument name/value pairs the agent passed to the tool. Optional for
    // backward compatibility with persisted records that predate this field.
    parameters?: ToolParameter[];
    // Lifecycle of the tool invocation. Set to "running" when the tool_action
    // event arrives; flipped to "success"/"error" by the paired tool_complete
    // event. Optional for backward compatibility with persisted records that
    // predate this field — treat a missing status as "success".
    status?: "running" | "success" | "error";
}

export interface ChatBotHistoryItem {
    type: ChatBotMessageType;
    content: string;
    tokens?: LLMToken[];
    toolActions?: ToolActionItem[];
    references?: string;
    feedback?: Feedback;
    messageId: string;
    complete?: boolean;
    startTime?: number; // Timestamp when request was sent
    endTime?: number; // Timestamp when response completed
    executionTimeMs?: number; // Calculated execution time in milliseconds
    reasoningContent?: string; // Model reasoning/thinking content
    structuredOutput?: string; // Structured output JSON from the agent
}

export interface Reference {
    referenceId: number;
    uri: string;
    pageNumber?: number;
    content: string;
    documentTitle: string;
}

export interface ChatInputState {
    value: string;
}

export interface ChatBotMessageResponse {
    action: ChatBotAction;
    data: {
        sessionId: string;
        content?: string;
        token?: LLMToken;
        references?: string;
        messageId: string;
        toolAction?: string;
        toolName?: string;
        invocationNumber?: number;
        reasoningContent?: string;
        structuredOutput?: string;
    };
}

export interface ChatBotHeartbeatRequest {
    action: ChatBotAction.Heartbeat;
    framework: Framework;
    data: {
        sessionId: string;
        agentRuntimeId?: string;
        qualifier?: string;
    };
}

export interface ChatBotRunRequest {
    action: ChatBotAction.Run;
    framework: Framework;
    data: {
        sessionId: string;
        messageId: string;
        text: string;
        inferenceConfig?: string;
        inferenceConfigName?: string;
        agentRuntimeId?: string;
        qualifier?: string;
    };
}

// -------------------- Agent/Endpoint Option Types -------------------
import type { IconProps } from "@cloudscape-design/components/icon";

export interface AgentOption {
    label: string;
    value: string;
    iconName?: IconProps.Name;
    disabled?: boolean;
    architectureType?: string;
    // JSON string mapping each endpoint (qualifier) to its numeric runtime
    // version. Used to persist the served version into session history.
    qualifierToVersion?: string;
}

export interface EndpointOption {
    label: string;
    value: string;
}
