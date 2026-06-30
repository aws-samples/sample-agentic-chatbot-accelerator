// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

export interface EvaluatorConfigType {
    supportedModels: Record<string, string>;
    passThreshold: number;
    defaultRubrics?: Record<string, string>;
}

export interface ExperimentsConfigType {
    enabled?: boolean;
    supportedModels: Record<string, string>;
    deployBatchInfrastructure?: boolean;
}

export interface AppConfig {
    aws_project_region: string;
    aws_account_id: string;
    aws_cognito_identity_pool_id: string;
    aws_user_pools_id: string;
    aws_user_pools_web_client_id: string;
    aws_bedrock_supported_models: Record<string, string>;
    aws_bedrock_supported_reranking_models?: Record<string, string>;
    knowledgeBaseIsSupported?: boolean;
    evaluatorConfig?: EvaluatorConfigType;
    experimentsConfig?: ExperimentsConfigType;
}

export interface NavigationPanelState {
    collapsed?: boolean;
    collapsedSections?: Record<number, boolean>;
}

// Evaluation Types
export enum EvaluatorType {
    OUTPUT = "OutputEvaluator",
    HELPFULNESS = "HelpfulnessEvaluator",
    FAITHFULNESS = "FaithfulnessEvaluator",
    TOOL_SELECTION = "ToolSelectionAccuracyEvaluator",
    TOOL_PARAMETER = "ToolParameterAccuracyEvaluator",
    TRAJECTORY = "TrajectoryEvaluator",
    INTERACTIONS = "InteractionsEvaluator",
    GOAL_SUCCESS_RATE = "GoalSuccessRateEvaluator",
    STRUCTURED_OUTPUT = "StructuredOutputEvaluator",
    CUSTOM = "Custom",
}

export interface Evaluator {
    evaluatorId: string;
    name: string;
    description?: string;
    evaluatorType: EvaluatorType | string;
    customRubric?: string;
    agentRuntimeName?: string;
    qualifier?: string;
    modelId?: string;
    passThreshold?: number;
    repeatCount?: number;
    testCasesS3Path?: string;
    testCasesCount?: number;
    createdAt: string;
    updatedAt?: string;
    // Denormalized pointer to the most recent run (for the list view)
    lastRunId?: string;
    lastRunStatus?: string;
    lastRunPassedCases?: number;
    lastRunFailedCases?: number;
    lastRunAt?: string;
}

// One execution of an evaluator. Snapshots the config it ran with.
export interface EvaluatorRun {
    runId: string;
    evaluatorId: string;
    evaluatorName?: string;
    evaluatorType?: string;
    customRubric?: string;
    agentRuntimeName?: string;
    qualifier?: string;
    modelId?: string;
    passThreshold?: number;
    repeatCount?: number;
    testCasesS3Path?: string;
    testCasesCount?: number;
    resultsS3Path?: string;
    // Status: Queued, Running, Completed, Failed
    status: string;
    totalCases?: number;
    passedCases?: number;
    failedCases?: number;
    skippedCases?: number;
    totalTimeMs?: number;
    results?: EvaluationResult[];
    errorMessage?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}

export interface TestCase {
    name: string;
    input: string;
    expected_output: string | Record<string, unknown>;
    state?: string;
    expected_trajectory?: string[];
    expected_interactions?: Record<string, unknown>[];
    metadata?: Record<string, string>;
}

export interface EvaluationResult {
    caseName: string;
    input?: string;
    expectedOutput?: string;
    actualOutput?: string;
    score: number;
    passed: boolean;
    // Per-case status: scored | skipped | error
    status?: string;
    reason: string;
    latencyMs?: number;
    // When repeatCount > 1, score is the MEAN and these are the individual runs.
    repeatCount?: number;
    repetitions?: EvaluationRepetition[];
}

export interface EvaluationRepetition {
    repeatIndex: number;
    actualOutput?: string;
    score: number;
    passed: boolean;
    status?: string;
    reason?: string;
    latencyMs?: number;
}

export interface EvaluationSummary {
    runId: string;
    evaluatorId: string;
    totalCases: number;
    passedCases: number;
    skippedCases?: number;
    totalTimeMs: number;
    status: string;
    completedAt?: string;
    results: EvaluationResult[];
}
