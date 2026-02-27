/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Lambdas Sub-module - Notify Runtime Update Lambda

Creates:
- Node.js Lambda for publishing runtime updates to AppSync
- Uses esbuild-bundled artifact from build process
*/

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "notify_runtime_update" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-notifyRuntimeUpdate"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-notifyRuntimeUpdate-logs"
  })
}

# -----------------------------------------------------------------------------
# Notify Runtime Update Lambda (Node.js/TypeScript)
# Publishes runtime status updates to AppSync subscription
# Built by CodeBuild — see shared module codebuild-layers.tf
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "notify_runtime_update" {
  # checkov:skip=CKV_AWS_116:DLQ handled by Step Functions retry
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-notifyRuntimeUpdate"
  description   = "Publishes runtime status updates to AppSync"

  # Source from S3 (built by CodeBuild)
  s3_bucket        = var.notify_runtime_update_s3_bucket
  s3_key           = var.notify_runtime_update_s3_key
  source_code_hash = base64sha256(var.notify_runtime_update_source_hash)
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 256

  role = aws_iam_role.notify_runtime_update.arn

  # Lambda Powertools TypeScript layer
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

  depends_on = [aws_cloudwatch_log_group.notify_runtime_update]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-notifyRuntimeUpdate"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Notify Runtime Update Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "notify_runtime_update" {
  name               = "${local.name_prefix}-notifyRuntimeUpdate-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-notifyRuntimeUpdate-role"
  })
}

resource "aws_iam_role_policy_attachment" "notify_runtime_update_basic" {
  role       = aws_iam_role.notify_runtime_update.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "notify_runtime_update_xray" {
  role       = aws_iam_role.notify_runtime_update.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# AppSync mutation permission
data "aws_iam_policy_document" "notify_runtime_update_appsync" {
  statement {
    sid    = "AppSyncMutation"
    effect = "Allow"
    actions = [
      "appsync:GraphQL"
    ]
    resources = [
      "arn:aws:appsync:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:apis/${var.appsync_api_id}/types/Mutation/fields/publishRuntimeUpdate"
    ]
  }
}

resource "aws_iam_role_policy" "notify_runtime_update_appsync" {
  name   = "${local.name_prefix}-notifyRuntimeUpdate-appsync"
  role   = aws_iam_role.notify_runtime_update.id
  policy = data.aws_iam_policy_document.notify_runtime_update_appsync.json
}
