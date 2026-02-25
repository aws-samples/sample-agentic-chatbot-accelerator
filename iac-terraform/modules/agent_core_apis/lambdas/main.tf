/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Lambdas Sub-module - Main Resolver Lambda

Creates:
- Main agentCoreResolver Lambda (Python) - handles CRUD operations
- IAM role with Bedrock AgentCore permissions
*/

locals {
  name_prefix   = lower(var.prefix)
  functions_dir = "${path.module}/../../../../lib/api/functions"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# CloudWatch Log Group for Main Resolver
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "agent_core_resolver" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-agentCoreResolver"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentCoreResolver-logs"
  })
}

# -----------------------------------------------------------------------------
# Main Agent Core Resolver Lambda
# Handles: createAgentCoreRuntime, listRuntimeAgents, getRuntimeConfiguration*,
#          tagAgentCoreRuntime, listAgentVersions, listAgentEndpoints,
#          deleteAgentRuntime, deleteAgentRuntimeEndpoints
# -----------------------------------------------------------------------------

data "archive_file" "agent_core_resolver" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/agent-factory-resolver"
  output_path = "${path.module}/../../../../iac-terraform/build/agent-factory-resolver.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache", "genai_core"]
}

resource "aws_lambda_function" "agent_core_resolver" {
  # checkov:skip=CKV_AWS_116:DLQ not needed for synchronous API resolver
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-agentCoreResolver"
  description   = "Main resolver for Bedrock AgentCore runtime operations"

  filename         = data.archive_file.agent_core_resolver.output_path
  source_code_hash = data.archive_file.agent_core_resolver.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 180 # 3 minutes
  memory_size      = 128

  role = aws_iam_role.agent_core_resolver.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      POWERTOOLS_SERVICE_NAME            = "agent-core-resolver"
      POWERTOOLS_LOG_LEVEL               = "INFO"
      CONTAINER_URI                      = var.container_uri
      SWARM_CONTAINER_URI                = var.swarm_container_uri
      AGENT_CORE_RUNTIME_ROLE_ARN        = var.agent_core_execution_role_arn
      AGENT_CORE_RUNTIME_TABLE           = var.agent_core_runtime_table_name
      AGENT_CORE_SUMMARY_TABLE           = var.agent_core_summary_table_name
      TOOL_REGISTRY_TABLE                = var.tool_registry_table_name
      MCP_SERVER_REGISTRY_TABLE          = var.mcp_server_registry_table_name
      ACCOUNT_ID                         = data.aws_caller_identity.current.account_id
      STACK_TAG                          = var.stack_tag
      ENVIRONMENT_TAG                    = var.environment_tag
      REGION_NAME                        = data.aws_region.current.id
      CREATE_RUNTIME_STATE_MACHINE_ARN   = var.create_runtime_state_machine_arn
      DELETE_RUNTIME_STATE_MACHINE_ARN   = var.delete_runtime_state_machine_arn
      DELETE_ENDPOINTS_STATE_MACHINE_ARN = var.delete_endpoints_state_machine_arn
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.agent_core_resolver]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentCoreResolver"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Main Resolver Lambda
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agent_core_resolver" {
  name               = "${local.name_prefix}-agentCoreResolver-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentCoreResolver-role"
  })
}

# Basic Lambda execution policy (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "agent_core_resolver_basic" {
  role       = aws_iam_role.agent_core_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "agent_core_resolver_xray" {
  role       = aws_iam_role.agent_core_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Bedrock AgentCore Full Access (managed policy)
# TODO: Consider using a custom policy with minimal permissions
resource "aws_iam_role_policy_attachment" "agent_core_resolver_bedrock" {
  role       = aws_iam_role.agent_core_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess"
}

# DynamoDB access policy
data "aws_iam_policy_document" "agent_core_resolver_dynamodb" {
  statement {
    sid    = "RuntimeTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ]
    resources = [
      var.agent_core_runtime_table_arn,
      "${var.agent_core_runtime_table_arn}/index/*"
    ]
  }

  statement {
    sid    = "SummaryTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ]
    resources = [
      var.agent_core_summary_table_arn,
      "${var.agent_core_summary_table_arn}/index/*"
    ]
  }

  statement {
    sid    = "KMSAccess"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "agent_core_resolver_dynamodb" {
  name   = "${local.name_prefix}-agentCoreResolver-dynamodb"
  role   = aws_iam_role.agent_core_resolver.id
  policy = data.aws_iam_policy_document.agent_core_resolver_dynamodb.json
}

# PassRole permission for Bedrock AgentCore
data "aws_iam_policy_document" "agent_core_resolver_passrole" {
  statement {
    sid       = "BedrockAgentCorePassRoleAccess"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [var.agent_core_execution_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "agent_core_resolver_passrole" {
  name   = "${local.name_prefix}-agentCoreResolver-passrole"
  role   = aws_iam_role.agent_core_resolver.id
  policy = data.aws_iam_policy_document.agent_core_resolver_passrole.json
}
