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

export interface AppConfig {
    aws_project_region: string;
    aws_cognito_identity_pool_id: string;
    aws_user_pools_id: string;
    aws_user_pools_web_client_id: string;
    aws_bedrock_supported_models: Record<string, string>;
    aws_bedrock_supported_reranking_models?: Record<string, string>;
    knowledgeBaseIsSupported?: boolean;
    evaluatorConfig?: EvaluatorConfigType;
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
    testCasesS3Path?: string;
    testCasesCount?: number;
    // Status: Created, Running, Completed, Failed
    status: string;
    passedCases?: number;
    failedCases?: number;
    totalTimeMs?: number;
    errorMessage?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
}

export interface TestCase {
    name: string;
    input: string;
    expected_output: string;
    metadata?: Record<string, string>;
}

export interface EvaluationResult {
    caseName: string;
    input?: string;
    expectedOutput?: string;
    actualOutput?: string;
    score: number;
    passed: boolean;
    reason: string;
    latencyMs?: number;
}

export interface EvaluationSummary {
    runId: string;
    evaluatorId: string;
    totalCases: number;
    passedCases: number;
    totalTimeMs: number;
    status: string;
    completedAt?: string;
    results: EvaluationResult[];
}
