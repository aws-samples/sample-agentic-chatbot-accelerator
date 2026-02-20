/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Cleanup Module

Creates:
- Lambda function for cleanup operations during terraform destroy
- null_resource that triggers cleanup on destroy
- IAM role with permissions for Bedrock, EventBridge, and AgentCore cleanup

Equivalent to: lib/cleanup/index.ts
*/

locals {
  name_prefix      = lower(var.prefix)
  lambda_asset_dir = "${path.module}/../../../lib/cleanup/functions/cleanup-handler"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "cleanup" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-cleanCustomResources"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-cleanCustomResources-logs"
  })
}

# -----------------------------------------------------------------------------
# Lambda Function Archive
# -----------------------------------------------------------------------------

data "archive_file" "cleanup" {
  type        = "zip"
  source_dir  = local.lambda_asset_dir
  output_path = "${path.module}/../../../iac-terraform/build/cleanup-handler.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache", "genai_core"]
}

# -----------------------------------------------------------------------------
# Lambda Function
# Handles cleanup operations on stack destruction
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "cleanup" {
  # checkov:skip=CKV_AWS_116:DLQ not needed - invoked synchronously during destroy
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit not needed - invoked once during destroy
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-cleanCustomResources"
  description   = "Cleans up user-created resources during stack destruction"

  filename         = data.archive_file.cleanup.output_path
  source_code_hash = data.archive_file.cleanup.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 900 # 15 minutes (max for Lambda)
  memory_size      = 256

  role = aws_iam_role.cleanup.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
  ]

  environment {
    variables = {
      # IaC-managed Knowledge Base IDs to preserve
      IAC_KNOWLEDGE_BASE_IDS = var.iac_knowledge_base_ids
      # IaC-managed EventBridge rule names to preserve
      IAC_RULE_NAMES = var.iac_rule_names
      # Tags to identify resources to clean up
      STACK_TAG       = var.stack_tag
      ENVIRONMENT_TAG = var.environment_tag
      # Owner tag value - resources with this Owner tag will be preserved
      # For Terraform deployments: "Terraform", for CDK: "CDK"
      IAC_OWNER_TAG = "Terraform"
      # Knowledge Base inventory table (optional)
      KB_INVENTORY_TABLE = var.kb_inventory_table_name
      # Logging
      LOG_LEVEL               = "INFO"
      POWERTOOLS_SERVICE_NAME = "aca-cleanUpResources"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.cleanup]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-cleanCustomResources"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Lambda
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

resource "aws_iam_role" "cleanup" {
  name               = "${local.name_prefix}-cleanup-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-cleanup-role"
  })
}

# Basic Lambda execution (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "cleanup_basic" {
  role       = aws_iam_role.cleanup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "cleanup_xray" {
  role       = aws_iam_role.cleanup.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Bedrock Knowledge Base permissions (tag-scoped)
data "aws_iam_policy_document" "cleanup_bedrock" {
  statement {
    sid    = "BedrockKnowledgeBaseCleanup"
    effect = "Allow"
    actions = [
      "bedrock:DeleteKnowledgeBase",
      "bedrock:DeleteDataSource",
      "bedrock:GetKnowledgeBase",
      "bedrock:ListDataSources",
    ]
    resources = [
      "arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
    ]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Stack"
      values   = [var.stack_tag]
    }
    dynamic "condition" {
      for_each = var.environment_tag != "" ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Environment"
        values   = [var.environment_tag]
      }
    }
  }
}

resource "aws_iam_role_policy" "cleanup_bedrock" {
  name   = "${local.name_prefix}-cleanup-bedrock"
  role   = aws_iam_role.cleanup.id
  policy = data.aws_iam_policy_document.cleanup_bedrock.json
}

# Bedrock AgentCore permissions (full access for cleanup)
# Using managed policy as AgentCore doesn't support tag-based conditions well
resource "aws_iam_role_policy_attachment" "cleanup_agentcore" {
  role       = aws_iam_role.cleanup.name
  policy_arn = "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess"
}

# EventBridge permissions (tag-scoped)
data "aws_iam_policy_document" "cleanup_events" {
  statement {
    sid    = "EventBridgeCleanup"
    effect = "Allow"
    actions = [
      "events:DeleteRule",
      "events:RemoveTargets",
      "events:ListTargetsByRule",
      "events:DescribeRule",
    ]
    resources = [
      "arn:aws:events:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:rule/*"
    ]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Stack"
      values   = [var.stack_tag]
    }
    dynamic "condition" {
      for_each = var.environment_tag != "" ? [1] : []
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Environment"
        values   = [var.environment_tag]
      }
    }
  }
}

resource "aws_iam_role_policy" "cleanup_events" {
  name   = "${local.name_prefix}-cleanup-events"
  role   = aws_iam_role.cleanup.id
  policy = data.aws_iam_policy_document.cleanup_events.json
}

# DynamoDB read access for KB inventory table (optional)
# Use kb_enabled flag instead of checking ARN to avoid "count depends on unknown value" errors
data "aws_iam_policy_document" "cleanup_dynamodb" {
  count = var.kb_enabled ? 1 : 0

  statement {
    sid    = "KBInventoryTableRead"
    effect = "Allow"
    actions = [
      "dynamodb:Scan",
      "dynamodb:GetItem",
    ]
    resources = [var.kb_inventory_table_arn]
  }

  # KMS access for decrypting the encrypted DynamoDB table
  statement {
    sid    = "KMSDecryptForDynamoDB"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "cleanup_dynamodb" {
  count = var.kb_enabled ? 1 : 0

  name   = "${local.name_prefix}-cleanup-dynamodb"
  role   = aws_iam_role.cleanup.id
  policy = data.aws_iam_policy_document.cleanup_dynamodb[0].json
}

# -----------------------------------------------------------------------------
# Cleanup Trigger Resource
# Invokes the cleanup Lambda during terraform destroy
# -----------------------------------------------------------------------------

resource "null_resource" "cleanup_trigger" {
  # These values are captured at creation time and used during destroy
  triggers = {
    lambda_function_name = aws_lambda_function.cleanup.function_name
    region               = data.aws_region.current.id
  }

  # This provisioner runs ONLY during terraform destroy
  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      echo "Invoking cleanup Lambda: ${self.triggers.lambda_function_name}"
      aws lambda invoke \
        --function-name ${self.triggers.lambda_function_name} \
        --region ${self.triggers.region} \
        --payload '{"RequestType": "Delete"}' \
        --cli-binary-format raw-in-base64-out \
        /tmp/cleanup-response.json 2>&1 || echo "Cleanup Lambda invocation failed, continuing destroy..."
      cat /tmp/cleanup-response.json 2>/dev/null || true
    EOT
  }

  # Explicit dependencies to prevent IAM from being destroyed before cleanup runs
  depends_on = [
    aws_lambda_function.cleanup,
    aws_iam_role_policy.cleanup_bedrock,
    aws_iam_role_policy.cleanup_events,
    aws_iam_role.cleanup
  ]
}
