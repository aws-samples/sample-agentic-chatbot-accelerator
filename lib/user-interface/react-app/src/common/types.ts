// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

export interface AppConfig {
    aws_project_region: string;
    aws_cognito_identity_pool_id: string;
    aws_user_pools_id: string;
    aws_user_pools_web_client_id: string;
    aws_bedrock_supported_models: Record<string, string>;
    aws_bedrock_supported_reranking_models?: Record<string, string>;
    knowledgeBaseIsSupported?: boolean;
}

export interface NavigationPanelState {
    collapsed?: boolean;
    collapsedSections?: Record<number, boolean>;
}
