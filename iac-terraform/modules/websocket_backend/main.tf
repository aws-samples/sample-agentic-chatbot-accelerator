/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
WebSocket Backend Module

Creates:
- SNS topic for message distribution
- Lambda function for outgoing message handling
- SNS subscription with direction filter
- IAM roles and permissions
*/

locals {
  name_prefix         = lower(var.prefix)
  lambda_function_dir = "${path.module}/../../../src/api/functions/outgoing-message-handler"
  resolvers_dir       = "${path.module}/../../../src/api/functions/resolvers"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# SNS Topic for Messages
# Used for real-time message distribution
# -----------------------------------------------------------------------------

resource "aws_sns_topic" "messages" {
  name              = "${local.name_prefix}-chatMessagesTopic"
  kms_master_key_id = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-chatMessagesTopic"
  })
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group for Lambda
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "outgoing_message_handler" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days for Lambda logs is acceptable
  name              = "/aws/lambda/${local.name_prefix}-outgoingMessageHandler"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-outgoingMessageHandler-logs"
  })
}

# -----------------------------------------------------------------------------
# Lambda Function for Outgoing Messages
# Subscribes to SNS and publishes to AppSync (publishResponse mutation)
# -----------------------------------------------------------------------------

# Lambda Function for Outgoing Messages
# Source from S3 (built by CodeBuild in shared module)
resource "aws_lambda_function" "outgoing_message_handler" {
  # checkov:skip=CKV_AWS_116:DLQ handled by SNS subscription retry policy
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-outgoingMessageHandler"
  description   = "Handles outgoing messages and publishes to AppSync"

  # Source from S3 (built by CodeBuild)
  s3_bucket        = var.outgoing_message_handler_s3_bucket
  s3_key           = var.outgoing_message_handler_s3_key
  source_code_hash = base64sha256(var.outgoing_message_handler_source_hash)
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 256

  role = aws_iam_role.outgoing_message_handler.arn

  # AWS Lambda Powertools for TypeScript layer
  # See: https://docs.powertools.aws.dev/lambda/typescript/latest/
  layers = [
    "arn:aws:lambda:${data.aws_region.current.id}:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:7"
  ]

  environment {
    variables = {
      GRAPHQL_ENDPOINT = var.graphql_url
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.outgoing_message_handler]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-outgoingMessageHandler"
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

resource "aws_iam_role" "outgoing_message_handler" {
  name               = "${local.name_prefix}-outgoingMsgHandler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-outgoingMsgHandler-role"
  })
}

# Basic Lambda execution policy (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "outgoing_handler_basic" {
  role       = aws_iam_role.outgoing_message_handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "outgoing_handler_xray" {
  role       = aws_iam_role.outgoing_message_handler.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# AppSync mutation policy
data "aws_iam_policy_document" "outgoing_handler_appsync" {
  statement {
    sid    = "AppSyncMutation"
    effect = "Allow"
    actions = [
      "appsync:GraphQL"
    ]
    resources = [
      "arn:aws:appsync:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:apis/${var.appsync_api_id}/*"
    ]
  }
}

resource "aws_iam_role_policy" "outgoing_handler_appsync" {
  name   = "${local.name_prefix}-outgoingHandler-appsync"
  role   = aws_iam_role.outgoing_message_handler.id
  policy = data.aws_iam_policy_document.outgoing_handler_appsync.json
}

# -----------------------------------------------------------------------------
# SNS Subscription with Filter
# Only processes messages with direction = "Out"
# -----------------------------------------------------------------------------

resource "aws_sns_topic_subscription" "outgoing_messages" {
  topic_arn = aws_sns_topic.messages.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.outgoing_message_handler.arn

  # Filter for outgoing messages
  # Note: direction must match exactly what invoke-agentCoreRuntime sends ("OUT" uppercase)
  filter_policy = jsonencode({
    direction = ["OUT"]
  })

  filter_policy_scope = "MessageBody"
}

# Lambda permission for SNS to invoke
resource "aws_lambda_permission" "sns_invoke" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.outgoing_message_handler.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.messages.arn
}

# -----------------------------------------------------------------------------
# AppSync None Data Source for WebSocket resolvers
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "websocket_none" {
  api_id = var.appsync_api_id
  name   = "WebsocketNoneDataSource"
  type   = "NONE"
}
