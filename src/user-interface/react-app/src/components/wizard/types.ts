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

export interface StructuredOutputField {
    name: string;
    pythonType: string;
    description: string;
    optional: boolean;
}

export interface AgentCoreRuntimeConfiguration {
    agentName: string;
    modelInferenceParameters: {
        modelId: string;
        parameters: {
            temperature: number;
            maxTokens: number;
        };
        reasoningBudget?: number | string;
    };
    instructions: string;
    tools: string[];
    toolParameters: {
        [toolName: string]: any;
    };
    mcpServers: string[];
    conversationManager: "null" | "sliding_window" | "summarizing";
    useMemory?: boolean;
    structuredOutput?: StructuredOutputField[];
    architectureType?: ArchitectureType;
    swarmConfig?: SwarmConfiguration;
    graphConfig?: GraphConfiguration;
    agentsAsToolsConfig?: AgentsAsToolsConfiguration;
}

export enum SearchType {
    SEMANTIC = "SEMANTIC",
    HYBRID = "HYBRID",
}

export type ArchitectureType = "SINGLE" | "SWARM" | "GRAPH" | "AGENTS_AS_TOOLS";

export interface SwarmAgentDefinition {
    name: string;
    instructions: string;
    modelInferenceParameters: {
        modelId: string;
        parameters: { temperature: number; maxTokens: number };
        reasoningBudget?: number | string;
    };
    tools: string[];
    toolParameters: { [toolName: string]: any };
    mcpServers: string[];
}

export interface AgentReference {
    agentName: string;
    endpointName: string;
}

export interface SwarmOrchestratorConfig {
    maxHandoffs: number;
    maxIterations: number;
    executionTimeoutSeconds: number;
    nodeTimeoutSeconds: number;
}

export interface SwarmConfiguration {
    agents: SwarmAgentDefinition[];
    agentReferences: AgentReference[];
    entryAgent: string;
    orchestrator: SwarmOrchestratorConfig;
    conversationManager: "null" | "sliding_window" | "summarizing";
}

/** Configuration for a dynamic_map node (Send()-based parallel fan-out). */
export interface DynamicMapConfig {
    /** State key containing the list to iterate over (e.g. "templates"). */
    sourceKey: string;
    /** Node ID that each Send() dispatches to (e.g. "fill_template"). */
    targetNode: string;
    /** State key set per-branch with the current list item (e.g. "template_name"). */
    itemStateKey: string;
}

export interface GraphNodeDefinition {
    id: string;
    /** Set for agent nodes. Omitted for fork and deterministic nodes. */
    agentName?: string;
    endpointName: string;
    /** Set for deterministic nodes — matches a key in deterministic_node_registry. */
    deterministicNodeKey?: string;
    /** Set for built-in node types: "fork" or "dynamic_map". */
    nodeType?: string;
    /** Configuration for dynamic_map nodes. Required when nodeType is "dynamic_map". */
    dynamicMapConfig?: DynamicMapConfig;
    label?: string;
    /**
     * Optional prompt template for this node. When set, overrides the
     * inherited graph-level prompt (messages). Supports {variable}
     * placeholders interpolated from the graph state.
     */
    promptTemplate?: string;
}

export interface GraphEdgeDefinition {
    source: string;
    target: string;
    condition?: string;
}

export interface GraphOrchestratorConfig {
    maxIterations: number;
    executionTimeoutSeconds: number;
    nodeTimeoutSeconds: number;
}

export interface GraphConfiguration {
    nodes: GraphNodeDefinition[];
    edges: GraphEdgeDefinition[];
    entryPoint: string;
    stateSchema: Record<string, string>;
    /** When set, uses a predefined state class instead of flat stateSchema. */
    stateClass?: string;
    orchestrator: GraphOrchestratorConfig;
}

/** Metadata for a deterministic node function available in the backend registry. */
export interface PredefinedDeterministicNode {
    key: string;
    label: string;
    description: string;
}

/** Metadata for a predefined state class available in the backend registry. */
export interface PredefinedStateClass {
    key: string;
    label: string;
    description: string;
    fields: string[];
}

/** Metadata for a predefined structured output model available in the backend registry. */
export interface PredefinedStructuredOutput {
    key: string;
    label: string;
    description: string;
    fields: string[];
}

export interface AgentAsToolDefinition {
    runtimeId: string;
    endpoint: string;
    role: string;
}

export interface AgentsAsToolsConfiguration {
    agentsAsTools: AgentAsToolDefinition[];
    modelInferenceParameters: {
        modelId: string;
        parameters: { temperature: number; maxTokens: number };
        reasoningBudget?: number | string;
    };
    instructions: string;
    tools?: string[];
    toolParameters?: { [toolName: string]: any };
    mcpServers?: string[];
    conversationManager: "null" | "sliding_window" | "summarizing";
}
