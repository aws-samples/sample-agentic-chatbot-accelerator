// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
export interface KnowledgeBaseCreationData {
    name: string;
    description: string;
    model: {
        id: string;
        precision: "FLOAT" | "BINARY";
        vectorSize: number;
    };
    dataSources: Array<{
        id: string;
        inputPrefix: string;
        dataSourcePrefix: string;
        description: string;
        chunkingProps: {
            type: "SEMANTIC" | "FIXED_SIZE" | "HIERARCHICAL" | "NONE";
            semanticChunkingProps?: {
                bufferSize: number;
                breakpointPercentileThreshold: number;
                maxTokens: number;
            };
            fixedChunkingProps?: {
                maxTokens: number;
                overlapPercentage: number;
            };
            hierarchicalChunkingProps?: {
                overlapTokens: number;
                maxParentTokenSize: number;
                maxChildTokenSize: number;
            };
        };
    }>;
}

export interface AgentCoreRuntimeConfiguration {
    agentName: string;
    modelInferenceParameters: {
        modelId: string;
        parameters: {
            temperature: number;
            maxTokens: number;
        };
    };
    instructions: string;
    tools: string[];
    toolParameters: {
        [toolName: string]: any;
    };
    mcpServers: string[];
    conversationManager: "null" | "sliding_window" | "summarizing";
    useMemory?: boolean;
}

export enum SearchType {
    SEMANTIC = "SEMANTIC",
    HYBRID = "HYBRID",
}
