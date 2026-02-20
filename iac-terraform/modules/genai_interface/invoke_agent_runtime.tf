/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Invoke AgentCore Runtime Lambda

Creates:
- CloudWatch Log Group
- Lambda Function for invoking AgentCore runtime
- IAM Role with permissions for DynamoDB, SNS, and Bedrock AgentCore
- SNS subscription to messages topic (direction = "In")

Equivalent to: invokeAgentCoreRuntime Lambda in lib/genai-interface/index.ts
*/

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "invoke_agent_runtime" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-invoke-agentCoreRuntime"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-invoke-agentCoreRuntime-logs"
  })
}

# -----------------------------------------------------------------------------
# Lambda Function Archive
# -----------------------------------------------------------------------------

data "archive_file" "invoke_agent_runtime" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/agent-core"
  output_path = "${path.module}/../../../iac-terraform/build/invoke-agent-runtime.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

# -----------------------------------------------------------------------------
# Lambda Function
# Handles AgentCore invocation via SNS, streams responses to clients
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "invoke_agent_runtime" {
  # checkov:skip=CKV_AWS_116:DLQ not needed - SNS handles retries
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-invoke-agentCoreRuntime"
  description   = "Invokes Bedrock AgentCore runtime and streams responses"

  filename         = data.archive_file.invoke_agent_runtime.output_path
  source_code_hash = data.archive_file.invoke_agent_runtime.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 900 # 15 minutes (max for Lambda)
  memory_size      = 512

  role = aws_iam_role.invoke_agent_runtime.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      SESSIONS_TABLE_NAME            = var.sessions_table_name
      SESSIONS_BY_USER_ID_INDEX_NAME = var.by_user_id_index
      MESSAGE_TOPIC_ARN              = var.messages_topic_arn
      ACCOUNT_ID                     = data.aws_caller_identity.current.account_id
      LOG_LEVEL                      = "INFO"
      POWERTOOLS_SERVICE_NAME        = "aca-agentCoreInterface"
      POWERTOOLS_METRICS_NAMESPACE   = "ACA"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.invoke_agent_runtime]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-invoke-agentCoreRuntime"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "invoke_agent_runtime" {
  name               = "${local.name_prefix}-invokeAgentRuntime-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-invokeAgentRuntime-role"
  })
}

# Basic Lambda execution (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "invoke_agent_runtime_basic" {
  role       = aws_iam_role.invoke_agent_runtime.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "invoke_agent_runtime_xray" {
  role       = aws_iam_role.invoke_agent_runtime.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# DynamoDB access for sessions table
data "aws_iam_policy_document" "invoke_agent_runtime_dynamodb" {
  statement {
    sid    = "SessionsTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [
      var.sessions_table_arn,
      "${var.sessions_table_arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "invoke_agent_runtime_dynamodb" {
  name   = "${local.name_prefix}-invokeAgentRuntime-dynamodb"
  role   = aws_iam_role.invoke_agent_runtime.id
  policy = data.aws_iam_policy_document.invoke_agent_runtime_dynamodb.json
}

# SNS publish permission for messages topic
data "aws_iam_policy_document" "invoke_agent_runtime_sns" {
  statement {
    sid    = "PublishToMessagesTopic"
    effect = "Allow"
    actions = [
      "sns:Publish",
    ]
    resources = [var.messages_topic_arn]
  }
}

resource "aws_iam_role_policy" "invoke_agent_runtime_sns" {
  name   = "${local.name_prefix}-invokeAgentRuntime-sns"
  role   = aws_iam_role.invoke_agent_runtime.id
  policy = data.aws_iam_policy_document.invoke_agent_runtime_sns.json
}

# Bedrock AgentCore permissions
# Note: Tag-based conditions (ABAC) not supported for runtime-endpoint sub-resources
# Access is scoped to account/region only
data "aws_iam_policy_document" "invoke_agent_runtime_agentcore" {
  statement {
    sid    = "InvokeAgentCore"
    effect = "Allow"
    actions = [
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:InvokeAgentRuntimeForUser",
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:runtime/*",
    ]
  }
}

resource "aws_iam_role_policy" "invoke_agent_runtime_agentcore" {
  name   = "${local.name_prefix}-invokeAgentRuntime-agentcore"
  role   = aws_iam_role.invoke_agent_runtime.id
  policy = data.aws_iam_policy_document.invoke_agent_runtime_agentcore.json
}

# KMS decrypt permission for encrypted resources
data "aws_iam_policy_document" "invoke_agent_runtime_kms" {
  statement {
    sid    = "KMSDecrypt"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "invoke_agent_runtime_kms" {
  name   = "${local.name_prefix}-invokeAgentRuntime-kms"
  role   = aws_iam_role.invoke_agent_runtime.id
  policy = data.aws_iam_policy_document.invoke_agent_runtime_kms.json
}

# -----------------------------------------------------------------------------
# SNS Subscription (receives messages with direction = "In" AND framework = "AGENT_CORE")
# The messages topic is shared; Lambda filters for AgentCore incoming messages
# -----------------------------------------------------------------------------

resource "aws_sns_topic_subscription" "invoke_agent_runtime" {
  topic_arn = var.messages_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.invoke_agent_runtime.arn

  # Filter for incoming AgentCore messages
  # Note: direction must match exactly what send-query-http-resolver.js sends
  filter_policy = jsonencode({
    direction = ["IN"]
    framework = ["AGENT_CORE"]
  })

  filter_policy_scope = "MessageBody"
}

# Lambda permission for SNS to invoke
resource "aws_lambda_permission" "invoke_agent_runtime_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.invoke_agent_runtime.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.messages_topic_arn
}
