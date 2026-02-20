/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AgentCore Module - IAM Resources

Creates:
- Execution role for Bedrock AgentCore Runtime
- Comprehensive policy for agent operations
*/

# -----------------------------------------------------------------------------
# AgentCore Execution Role
# This role is assumed by Bedrock AgentCore to execute agent operations
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "agentcore_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-BedrockAgentCore-execution-role"
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume_role.json

  tags = {
    Name = "${local.name_prefix}-BedrockAgentCore-execution-role"
  }
}

# -----------------------------------------------------------------------------
# AgentCore Execution Policy
# Comprehensive policy matching CDK executionRole permissions
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "agentcore_execution" {
  # ECR Image Access
  statement {
    sid = "ECRImageAccess"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [aws_ecr_repository.agent_core.arn]
  }

  # ECR Token Access
  statement {
    sid       = "ECRTokenAccess"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # CloudWatch Logs - Log Group Management
  statement {
    actions = [
      "logs:DescribeLogStreams",
      "logs:CreateLogGroup"
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"
    ]
  }

  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:*"]
  }

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"
    ]
  }

  # X-Ray Tracing
  statement {
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets"
    ]
    resources = ["*"]
  }

  # CloudWatch Metrics
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }

  # Workload Access Token
  statement {
    sid = "GetAgentAccessToken"
    actions = [
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
      "bedrock-agentcore:GetWorkloadAccessTokenForUserId"
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default/workload-identity/*"
    ]
  }

  # Bedrock Model Invocation
  statement {
    sid = "BedrockModelInvocation"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream"
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
    ]
  }

  # Bedrock Knowledge Base (Retrieve and Rerank)
  statement {
    sid = "RetrieveFromBedrockKB"
    actions = [
      "bedrock:Retrieve",
      "bedrock:GetKnowledgeBase"
    ]
    resources = ["arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"]
    # Note: Tag conditions can be added here if needed
  }

  statement {
    sid       = "BedrockReranking"
    actions   = ["bedrock:Rerank"]
    resources = ["*"]
  }

  # AWS Marketplace Access
  statement {
    sid = "AWSMarketplaceAccess"
    actions = [
      "aws-marketplace:ViewSubscriptions",
      "aws-marketplace:Subscribe"
    ]
    resources = ["*"]
  }

  # AgentCore Runtime Actions
  statement {
    sid = "AgentCoreRuntimeActions"
    actions = [
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:ListAgentRuntimes",
      "bedrock-agentcore:InvokeAgentRuntimeForUser"
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:runtime/*"
    ]
  }

  # AgentCore Gateway Actions
  statement {
    sid     = "AgentCoreGatewayActions"
    actions = ["bedrock-agentcore:InvokeGateway"]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:gateway/*"
    ]
  }

  # AgentCore Memory Actions
  statement {
    sid = "AgentCoreMemoryActions"
    actions = [
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:GetMemory",
      "bedrock-agentcore:CreateEvent",
      "bedrock-agentcore:ListMemories",
      "bedrock-agentcore:DeleteMemoryRecord",
      "bedrock-agentcore:GetMemoryRecord",
      "bedrock-agentcore:ListMemoryRecords",
      "bedrock-agentcore:RetrieveMemoryRecords"
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:memory/*"
    ]
  }

  # DynamoDB Access - Agent Runtime Config Table
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.agent_runtime_config.arn]
  }

  # DynamoDB Access - Tool and MCP Server Registries
  statement {
    actions = ["dynamodb:Scan"]
    resources = [
      aws_dynamodb_table.tool_registry.arn,
      aws_dynamodb_table.mcp_server_registry.arn
    ]
  }

  # SNS Publish - Agent Tools Topic
  statement {
    sid       = "PublishToAgentToolsTopic"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.agent_tools.arn]
  }

  # KMS Access - For encrypted DynamoDB, SNS, and ECR resources
  statement {
    sid = "KMSAccess"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  # checkov:skip=CKV_AWS_290:AgentCore execution role requires broad permissions for agent operations
  # checkov:skip=CKV_AWS_287:AgentCore requires workload access token permissions
  # checkov:skip=CKV_AWS_289:AgentCore requires broad permissions for runtime operations
  # checkov:skip=CKV_AWS_355:ECR GetAuthorizationToken requires resource "*"
  name   = "${local.name_prefix}-AgentCorePolicy"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.agentcore_execution.json
}
