/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Agent Tools Handler Lambda

Creates:
- CloudWatch Log Group
- Lambda Function for processing agent tools messages
- IAM Role with permissions for SNS and Bedrock InvokeModel
- SNS subscription to agent tools topic

Equivalent to: agentToolsHandler Lambda in lib/genai-interface/index.ts
*/

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "agent_tools_handler" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-agent-tools-handler"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agent-tools-handler-logs"
  })
}

# -----------------------------------------------------------------------------
# Lambda Function Archive
# -----------------------------------------------------------------------------

data "archive_file" "agent_tools_handler" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/agent-tools-handler"
  output_path = "${path.module}/../../../iac-terraform/build/agent-tools-handler.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

# -----------------------------------------------------------------------------
# Lambda Function
# Processes agent tools messages, uses Bedrock to describe actions for UI
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "agent_tools_handler" {
  # checkov:skip=CKV_AWS_116:DLQ not needed - SNS handles retries
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-agent-tools-handler"
  description   = "Processes agent tools messages and describes actions for UI"

  filename         = data.archive_file.agent_tools_handler.output_path
  source_code_hash = data.archive_file.agent_tools_handler.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 60 # 1 minute
  memory_size      = 256

  role = aws_iam_role.agent_tools_handler.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      MESSAGE_TOPIC_ARN            = var.messages_topic_arn
      LOG_LEVEL                    = "INFO"
      POWERTOOLS_SERVICE_NAME      = "aca-agentToolsHandler"
      POWERTOOLS_METRICS_NAMESPACE = "ACA"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.agent_tools_handler]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agent-tools-handler"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "agent_tools_handler" {
  name               = "${local.name_prefix}-agentToolsHandler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-agentToolsHandler-role"
  })
}

# Basic Lambda execution (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "agent_tools_handler_basic" {
  role       = aws_iam_role.agent_tools_handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "agent_tools_handler_xray" {
  role       = aws_iam_role.agent_tools_handler.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# SNS publish permission for messages topic
data "aws_iam_policy_document" "agent_tools_handler_sns" {
  statement {
    sid    = "PublishToMessagesTopic"
    effect = "Allow"
    actions = [
      "sns:Publish",
    ]
    resources = [var.messages_topic_arn]
  }
}

resource "aws_iam_role_policy" "agent_tools_handler_sns" {
  name   = "${local.name_prefix}-agentToolsHandler-sns"
  role   = aws_iam_role.agent_tools_handler.id
  policy = data.aws_iam_policy_document.agent_tools_handler_sns.json
}

# Bedrock InvokeModel permissions for describing agent actions
data "aws_iam_policy_document" "agent_tools_handler_bedrock" {
  statement {
    sid    = "InvokeBedrock"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:${data.aws_region.current.id}::foundation-model/*",
      "arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*",
    ]
  }
}

resource "aws_iam_role_policy" "agent_tools_handler_bedrock" {
  name   = "${local.name_prefix}-agentToolsHandler-bedrock"
  role   = aws_iam_role.agent_tools_handler.id
  policy = data.aws_iam_policy_document.agent_tools_handler_bedrock.json
}

# KMS decrypt permission for encrypted resources
data "aws_iam_policy_document" "agent_tools_handler_kms" {
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

resource "aws_iam_role_policy" "agent_tools_handler_kms" {
  name   = "${local.name_prefix}-agentToolsHandler-kms"
  role   = aws_iam_role.agent_tools_handler.id
  policy = data.aws_iam_policy_document.agent_tools_handler_kms.json
}

# -----------------------------------------------------------------------------
# SNS Subscription to Agent Tools Topic
# Receives all messages from the agent tools topic
# -----------------------------------------------------------------------------

resource "aws_sns_topic_subscription" "agent_tools_handler" {
  topic_arn = var.agent_tools_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.agent_tools_handler.arn
}

# Lambda permission for SNS to invoke
resource "aws_lambda_permission" "agent_tools_handler_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_tools_handler.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.agent_tools_topic_arn
}
