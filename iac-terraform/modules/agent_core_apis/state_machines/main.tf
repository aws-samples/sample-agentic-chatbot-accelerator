/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - State Machines Sub-module

Creates:
- CloudWatch log group for Step Functions
- 3 Step Functions state machines:
  1. Delete AgentCore Endpoints
  2. Delete AgentCore Runtime
  3. Create AgentCore Runtime
- IAM roles and permissions for Step Functions
*/

locals {
  name_prefix        = lower(var.prefix)
  state_machines_dir = "${path.module}/../../../../lib/api/state-machines"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# CloudWatch Log Group for Step Functions
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "step_functions" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 30 days acceptable
  name              = "/aws/${local.name_prefix}/states/agentFactory/logs"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentFactory-stepfunctions-logs"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Step Functions
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "sfn_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "step_functions" {
  name               = "${local.name_prefix}-agentFactory-sfn-role"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentFactory-sfn-role"
  })
}

# X-Ray tracing policy
resource "aws_iam_role_policy_attachment" "step_functions_xray" {
  role       = aws_iam_role.step_functions.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# CloudWatch Logs policy
data "aws_iam_policy_document" "step_functions_logs" {
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "step_functions_logs" {
  name   = "${local.name_prefix}-agentFactory-sfn-logs"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions_logs.json
}

# Lambda invocation policy
data "aws_iam_policy_document" "step_functions_lambda" {
  statement {
    sid    = "InvokeLambdas"
    effect = "Allow"
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [
      var.delete_endpoint_function_arn,
      var.check_delete_endpoint_function_arn,
      var.list_endpoints_function_arn,
      var.delete_runtime_function_arn,
      var.check_delete_runtime_function_arn,
      var.check_exist_memory_function_arn,
      var.delete_memory_function_arn,
      var.check_delete_memory_function_arn,
      var.create_memory_function_arn,
      var.check_create_memory_function_arn,
      var.create_runtime_version_function_arn,
      var.check_create_runtime_function_arn,
      var.remove_references_function_arn,
      var.notify_runtime_update_function_arn,
    ]
  }
}

resource "aws_iam_role_policy" "step_functions_lambda" {
  name   = "${local.name_prefix}-agentFactory-sfn-lambda"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions_lambda.json
}

# DynamoDB access policy
data "aws_iam_policy_document" "step_functions_dynamodb" {
  statement {
    sid    = "SummaryTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query"
    ]
    resources = [
      var.agent_core_summary_table_arn,
      "${var.agent_core_summary_table_arn}/index/*"
    ]
  }

  statement {
    sid    = "RuntimeTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem"
    ]
    resources = [
      var.agent_core_runtime_table_arn
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

resource "aws_iam_role_policy" "step_functions_dynamodb" {
  name   = "${local.name_prefix}-agentFactory-sfn-dynamodb"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions_dynamodb.json
}

# -----------------------------------------------------------------------------
# Step Function 1: Delete AgentCore Endpoints
# Handles bulk deletion of runtime endpoints
# -----------------------------------------------------------------------------

resource "aws_sfn_state_machine" "delete_endpoints" {
  # checkov:skip=CKV_AWS_285:Logging is enabled via logging_configuration
  name     = "${local.name_prefix}-deleteAgentCoreEndpoint"
  role_arn = aws_iam_role.step_functions.arn

  definition = templatefile("${local.state_machines_dir}/delete-agentcore-endpoints.json", {
    startRuntimeEndpointDeletionFunctionArn = var.delete_endpoint_function_arn
    checkOnEndpointDeleteFunctionArn        = var.check_delete_endpoint_function_arn
    summaryTableArn                         = var.agent_core_summary_table_arn
    notifyRuntimeUpdateFunctionArn          = var.notify_runtime_update_function_arn
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.step_functions.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-deleteAgentCoreEndpoint"
  })
}

# -----------------------------------------------------------------------------
# Step Function 2: Delete AgentCore Runtime
# Full runtime deletion including endpoints, memory, and cleanup
# -----------------------------------------------------------------------------

resource "aws_sfn_state_machine" "delete_runtime" {
  # checkov:skip=CKV_AWS_285:Logging is enabled via logging_configuration
  name     = "${local.name_prefix}-deleteAgentCoreRuntime"
  role_arn = aws_iam_role.step_functions.arn

  definition = templatefile("${local.state_machines_dir}/delete-agentcore-runtime.json", {
    listRuntimeEndpointFunctionArn          = var.list_endpoints_function_arn
    startRuntimeEndpointDeletionFunctionArn = var.delete_endpoint_function_arn
    checkOnEndpointDeleteFunctionArn        = var.check_delete_endpoint_function_arn
    startDeleteRuntimeFunctionArn           = var.delete_runtime_function_arn
    checkOnDeleteRuntimeFunctionArn         = var.check_delete_runtime_function_arn
    summaryTableArn                         = var.agent_core_summary_table_arn
    notifyRuntimeUpdateFunctionArn          = var.notify_runtime_update_function_arn
    checkOnExistingMemoryFunctionArn        = var.check_exist_memory_function_arn
    startDeleteMemoryFunctionArn            = var.delete_memory_function_arn
    checkOnDeleteMemoryFunctionArn          = var.check_delete_memory_function_arn
    removeRuntimeVersionsFunctionArn        = var.remove_references_function_arn
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.step_functions.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-deleteAgentCoreRuntime"
  })
}

# -----------------------------------------------------------------------------
# Step Function 3: Create AgentCore Runtime
# Creates or updates runtime with memory support
# -----------------------------------------------------------------------------

resource "aws_sfn_state_machine" "create_runtime" {
  # checkov:skip=CKV_AWS_285:Logging is enabled via logging_configuration
  name     = "${local.name_prefix}-createAgentCoreRuntime"
  role_arn = aws_iam_role.step_functions.arn

  definition = templatefile("${local.state_machines_dir}/create-agentcore-runtime.json", {
    startMemoryCreationFuncArn       = var.create_memory_function_arn
    checkOnExistingMemoryFunctionArn = var.check_exist_memory_function_arn
    checkOnCreateMemoryFuncArn       = var.check_create_memory_function_arn
    startRuntimeCreationFuncArn      = var.create_runtime_version_function_arn
    checkOnRuntimeCreationFunc       = var.check_create_runtime_function_arn
    notifyRuntimeUpdateFunctionArn   = var.notify_runtime_update_function_arn
    summaryTableArn                  = var.agent_core_summary_table_arn
    agentVersionTableArn             = var.agent_core_runtime_table_arn
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.step_functions.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-createAgentCoreRuntime"
  })
}
