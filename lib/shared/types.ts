/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

/**
 * Enum representing the direction of message flow in relation to an SNS topic.
 * IN - Messages flowing into the SNS topic
 * OUT - Messages flowing out from the SNS topic
 */
export enum Direction {
    In = "IN",
    Out = "OUT",
}

/**
 * Enum representing different strategies for chunking text data.
 * FIXED_SIZE - Splits text into chunks of fixed token size with optional overlap
 * HIERARCHICAL - Creates a hierarchical structure of chunks with parent-child relationships
 * SEMANTIC - Chunks text based on semantic meaning and natural breakpoints
 * NONE - No chunking applied, processes text as-is
 */
export enum ChunkingStrategyType {
    FIXED_SIZE = "FIXED_SIZE",
    HIERARCHICAL = "HIERARCHICAL",
    SEMANTIC = "SEMANTIC",
    NONE = "NONE",
}

/**
 * Enum representing different search strategies for knowledge base queries.
 * SEMANTIC - Uses semantic similarity based on vector embeddings to find relevant content
 * HYBRID - Combines semantic search with keyword-based search for improved retrieval accuracy
 */
export enum SearchType {
    SEMANTIC = "SEMANTIC",
    HYBRID = "HYBRID",
}

/**
 * Enum representing the different agent frameworks supported by the system. Only AGENT_CORE is used in this version of the code.
 * BEDROCK_MANAGED - Uses AWS Bedrock's managed agent infrastructure
 * STRANDS - Uses the Strands agent framework for custom agent implementations
 * AGENT_CORE - Uses the internal AgentCore framework for agent orchestration
 */
export enum Framework {
    BEDROCK_MANAGED = "BEDROCK_MANAGED",
    STRANDS = "STRANDS",
    AGENT_CORE = "AGENT_CORE",
}

/**
 * Interface defining properties for fixed-size text chunking strategy
 * @property maxTokens - Maximum number of tokens per chunk
 * @property overlapPercentage - Percentage of tokens to overlap between consecutive chunks
 *
 * @note Maximum numbed of tokens for Titan and Cohere models are 8192 and 512 respectively
 */
interface FixedChunkingProps {
    maxTokens: number;
    overlapPercentage: number;
}

/**
 * Interface defining properties for hierarchical text chunking strategy
 * @property overlapTokens - Number of tokens to overlap between parent and child chunks
 * @property maxParentTokenSize - Maximum number of tokens allowed in parent chunks
 * @property maxChildTokenSize - Maximum number of tokens allowed in child chunks
 *
 * @note Maximum numbed of tokens for Titan and Cohere models are 8192 and 512 respectively
 */
interface HierarchicalChunkingProps {
    overlapTokens: number;
    maxParentTokenSize: number;
    maxChildTokenSize: number;
}

/**
 * Interface defining properties for semantic text chunking strategy
 * @property bufferSize - Size of the buffer window used for analyzing semantic breakpoints
 * @property breakpointPercentileThreshold - Percentile threshold for determining semantic breakpoints
 * @property maxTokens - Maximum number of tokens allowed per semantic chunk
 *
 * @note Maximum numbed of tokens for Titan and Cohere models are 8192 and 512 respectively
 */
interface SemanticChunkingProps {
    bufferSize: number;
    breakpointPercentileThreshold: number;
    maxTokens: number;
}

/**
 * Interface defining the configuration properties for different text chunking strategies
 * @property type - The type of chunking strategy to use (Fixed, Hierarchical, Semantic, or None)
 * @property fixedChunkingProps - Optional configuration for fixed-size chunking strategy
 * @property hierarchicalChunkingProps - Optional configuration for hierarchical chunking strategy
 * @property semanticChunkingProps - Optional configuration for semantic chunking strategy
 */
interface ChunkingStrategyProps {
    type: ChunkingStrategyType;
    fixedChunkingProps?: FixedChunkingProps;
    hierarchicalChunkingProps?: HierarchicalChunkingProps;
    semanticChunkingProps?: SemanticChunkingProps;
}

/**
 * Interface defining parameters for knowledge base configuration
 * @property chunkingStrategy - Configuration for text chunking strategy including type and specific properties
 * @property embeddingModel - Configuration for the embedding model
 *   - modelId: Identifier for the embedding model to use
 *   - vectorDimension: Dimension of the embedding vectors produced by the model
 * @property dataSourcePrefix - S3 prefix path for the knowledge base data source
 * @property description - Optional description of the knowledge base
 */
export interface KnowledgeBaseParameters {
    chunkingStrategy: ChunkingStrategyProps;

    embeddingModel: {
        modelId:
            | "amazon.titan-embed-text-v2:0"
            | "cohere.embed-english-v3"
            | "cohere.embed-multilingual-v3";
        vectorDimension: 256 | 512 | 1024;
    };

    dataSourcePrefix: string;

    description?: string;
}

/**
 * Interface defining parameters for data processing configuration
 * @property inputPrefix - Prefix for input data files/paths
 * @property dataSourcePrefix - Prefix for data source files/paths
 * @property processingPrefix - Prefix for processed data files/paths
 * @property stagingMidfix - Middle part of staging file/path names
 * @property transcribeMidfix - Middle part of transcribe file/path names
 * @property languageCode - Code representing the language for processing audio/video files with Amazon Transcribe
 */
export interface DataProcessingParameters {
    inputPrefix: string;
    dataSourcePrefix: string;
    processingPrefix: string;
    stagingMidfix: string;
    transcribeMidfix: string;
    languageCode: string;
}

/**
 * Interface defining the structure of a tool available to agents.
 * @property name - Unique identifier name for the tool
 * @property description - Human-readable description of the tool's functionality
 * @property invokesSubAgent - Flag indicating whether this tool triggers a sub-agent execution
 */
interface Tool {
    name: string;
    description: string;
    invokesSubAgent: boolean;
}

/**
 * Base interface for MCP server configuration shared properties.
 * @property name - Unique identifier name for the MCP server
 * @property description - Human-readable description of the MCP server's capabilities
 */
interface McpServerBase {
    name: string;
    description: string;
}

/**
 * MCP server configuration for AgentCore Runtime hosting.
 * @property runtimeId - The runtime identifier from AgentCore Runtime deployment
 * @property qualifier - Optional endpoint qualifier (defaults to "DEFAULT")
 */
interface McpServerRuntime extends McpServerBase {
    runtimeId: string;
    qualifier?: string;
    gatewayId?: never;
}

/**
 * MCP server configuration for AgentCore Gateway hosting.
 * @property gatewayId - The gateway identifier from AgentCore Gateway deployment
 */
interface McpServerGateway extends McpServerBase {
    gatewayId: string;
    runtimeId?: never;
}

/**
 * Union type for MCP server configuration.
 * MCP servers provide external capabilities and resources to agents.
 * Must specify exactly one of runtimeId (for AgentCore Runtime) or gatewayId (for AgentCore Gateway).
 */
export type McpServer = McpServerRuntime | McpServerGateway;

/**
 * Interface defining configuration properties for the ingestion Lambda function.
 * @property timeoutInMinutes - Maximum execution time allowed for the Lambda function in minutes
 * @property reservedConcurrency - Optional limit on concurrent Lambda executions to control throughput
 */
interface IngestionLambdaProps {
    timeoutInMinutes: number;
    reservedConcurrency?: number;
}

/**
 * Interface defining configuration for AgentCore observability features.
 * @property enableTransactionSearch - Flag to enable transaction search capabilities for debugging and analysis
 * @property indexingPercentage - Percentage of transactions to index for observability (0-100)
 */
interface ObservabilityProps {
    enableTransactionSearch: boolean;
    indexingPercentage: number;
}

/**
 * Interface defining the inference parameters for a foundation model.
 * @property modelId - Identifier of the foundation model to use for inference
 * @property parameters - Configuration parameters controlling model behavior
 *   - temperature: Controls randomness in responses (0.0 = deterministic, 1.0 = maximum randomness)
 *   - maxTokens: Maximum number of tokens to generate in the response
 *   - stopSequences: Optional array of sequences that will stop generation when encountered
 */
export interface ModelInferenceParameters {
    modelId: string;
    parameters: {
        temperature: number;
        maxTokens: number;
        stopSequences?: string[] | null;
    };
}

/**
 * Interface defining configuration for agent memory persistence.
 * @property retentionDays - Number of days to retain conversation memory before automatic cleanup
 * @property description - Optional description of the memory configuration purpose
 */
export interface MemoryConfiguration {
    retentionDays: number;
    description?: string;
}

/**
 * Interface defining lifecycle management configuration for agent runtimes.
 * @property idleRuntimeSessionTimeoutInMinutes - Time in minutes before an idle runtime session is terminated
 * @property maxLifetimeInHours - Maximum total lifetime of a runtime instance in hours, regardless of activity
 */
export interface LifecycleConfiguration {
    idleRuntimeSessionTimeoutInMinutes: number;
    maxLifetimeInHours: number;
}

/**
 * Interface defining the complete configuration for an agent runtime instance.
 * @property modelInferenceParameters - Configuration for the underlying foundation model
 * @property instructions - System prompt/instructions that define the agent's behavior and personality
 * @property tools - Array of tool names available to the agent for task execution
 * @property toolParameters - Generic dictionary of dictionaries containing tool-specific configuration parameters
 * @property conversationManager - Strategy for managing conversation context:
 *   - "sliding_window": Maintains a sliding window of recent messages
 *   - "summarization": Summarizes older messages to preserve context while reducing token usage
 *   - "none": No conversation management, each turn is independent
 * @property description - Optional description of the agent runtime's purpose
 * @property memoryCfg - Optional configuration for persistent memory across sessions
 * @property lifecycleCfg - Optional configuration for runtime lifecycle management
 */
export interface AgentRuntimeConfig {
    modelInferenceParameters: ModelInferenceParameters;
    instructions: string;
    tools: string[];
    toolParameters: Record<string, Record<string, unknown>>; // Generic dict of dicts
    mcpServers: string[];
    conversationManager: "sliding_window" | "summarization" | "none";
    description?: string;
    memoryCfg?: MemoryConfiguration;
    lifecycleCfg?: LifecycleConfiguration;
}

/**
 * Interface defining configuration for the evaluation framework.
 * @property supportedModels - Record mapping user-friendly model names to Bedrock model identifiers for evaluations.
 *                             The first model in this record is used as the default.
 * @property passThreshold - Score threshold (0.0-1.0) above which a test case is considered passed.
 * @property defaultRubrics - Optional record mapping evaluator types to their default rubric text
 */
export interface EvaluatorConfig {
    supportedModels: Record<string, string>;
    passThreshold: number;
    defaultRubrics?: Record<string, string>;
}

/**
 * Configuration interface for the CDK deployment.
 * This is the main configuration object that controls the entire system deployment.
 *
 * @property prefix - Prefix string used for naming AWS resources (e.g., "myapp" results in "myapp-lambda-xyz")
 * @property enableGeoRestrictions - Flag to enable CloudFront geographic restrictions on content delivery
 * @property allowedGeoRegions - List of ISO 3166-1 alpha-2 country codes allowed to access the application when geo-restrictions are enabled
 * @property dataProcessingParameters - Optional configuration for document data processing pipelines (ingestion, transcription, etc.)
 * @property knowledgeBaseParameters - Optional configuration for the Amazon Bedrock knowledge base (chunking, embedding model, data source)
 * @property supportedModels - Record mapping user-friendly model names to their Bedrock model identifiers (e.g., {"Claude 3.5 Sonnet": "anthropic.claude-3-5-sonnet-20241022-v2:0"})
 * @property rerankingModels - Record mapping user-friendly reranking model names to their Bedrock model identifiers
 * @property toolRegistry - Array of Tool objects defining the tools available to agents for task execution
 * @property mcpServerRegistry - Array of MCP server configurations for external capability providers
 * @property ingestionLambdaProps - Configuration properties for the document ingestion Lambda function (timeout, concurrency)
 * @property agentCoreObservability - Optional configuration to enable AgentCore observability features (transaction search, indexing)
 * @property agentRuntimeConfig - Optional default configuration for agent runtime instances (model, instructions, tools, conversation management)
 */
export interface SystemConfig {
    prefix: string;

    enableGeoRestrictions: boolean;

    allowedGeoRegions: string[];

    dataProcessingParameters?: DataProcessingParameters;

    knowledgeBaseParameters?: KnowledgeBaseParameters;

    supportedModels: Record<string, string>;

    rerankingModels?: Record<string, string>;

    toolRegistry: Tool[];

    mcpServerRegistry: McpServer[];

    ingestionLambdaProps: IngestionLambdaProps;

    agentCoreObservability?: ObservabilityProps;

    agentRuntimeConfig?: AgentRuntimeConfig;

    evaluatorConfig?: EvaluatorConfig;
}
