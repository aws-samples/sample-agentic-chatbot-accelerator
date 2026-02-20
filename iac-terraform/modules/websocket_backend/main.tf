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
  lambda_function_dir = "${path.module}/../../../lib/api/functions/outgoing-message-handler"
  resolvers_dir       = "${path.module}/../../../lib/api/functions/resolvers"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# SNS Topic for Messages
# Used for real-time message distribution
# -----------------------------------------------------------------------------

resource "aws_sns_topic" "messages" {
  # checkov:skip=CKV_AWS_26:No sensitive data in topic - message routing only
  name = "${local.name_prefix}-chatMessagesTopic"

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

# Build TypeScript Lambda using esbuild
# This compiles index.ts to dist/index.js with all dependencies bundled
resource "null_resource" "build_outgoing_message_handler" {
  triggers = {
    # Rebuild when source files change
    index_hash   = filemd5("${local.lambda_function_dir}/index.ts")
    graphql_hash = filemd5("${local.lambda_function_dir}/graphql.ts")
    always_run   = timestamp() # Force rebuild on each apply for now
  }

  provisioner "local-exec" {
    working_dir = local.lambda_function_dir
    command     = <<-EOT
      # Install esbuild if not present
      npm install --save-dev esbuild 2>/dev/null || true

      # Bundle TypeScript to JavaScript
      npx esbuild index.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --outfile=dist/index.js \
        --external:@aws-sdk/* \
        --minify

      echo "TypeScript build complete: dist/index.js"
    EOT
  }
}

# Archive the compiled JavaScript
data "archive_file" "outgoing_message_handler" {
  type        = "zip"
  source_dir  = "${local.lambda_function_dir}/dist"
  output_path = "${path.module}/../../../iac-terraform/build/outgoing-message-handler.zip"

  depends_on = [null_resource.build_outgoing_message_handler]
}

resource "aws_lambda_function" "outgoing_message_handler" {
  # checkov:skip=CKV_AWS_116:DLQ handled by SNS subscription retry policy
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-outgoingMessageHandler"
  description   = "Handles outgoing messages and publishes to AppSync"

  filename         = data.archive_file.outgoing_message_handler.output_path
  source_code_hash = data.archive_file.outgoing_message_handler.output_base64sha256
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
