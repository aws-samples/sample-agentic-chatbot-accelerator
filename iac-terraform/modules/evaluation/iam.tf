/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - IAM Roles and Policies
*/

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

# -----------------------------------------------------------------------------
# EvaluationResolver IAM Role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "evaluation_resolver" {
  name               = "${local.name_prefix}-evaluation-resolver-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = merge(var.tags, { Name = "${local.name_prefix}-evaluation-resolver-role" })
}

resource "aws_iam_role_policy_attachment" "evaluation_resolver_basic" {
  role       = aws_iam_role.evaluation_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "evaluation_resolver_xray" {
  role       = aws_iam_role.evaluation_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "evaluation_resolver" {
  name = "${local.name_prefix}-evaluation-resolver-policy"
  role = aws_iam_role.evaluation_resolver.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          var.evaluators_table_arn,
          "${var.evaluators_table_arn}/index/*"
        ]
      },
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.evaluations.arn,
          "${aws_s3_bucket.evaluations.arn}/*"
        ]
      },
      {
        Sid      = "SQSSendMessages"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.evaluation.arn]
      },
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# EvaluationExecutor IAM Role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "evaluation_executor" {
  name               = "${local.name_prefix}-evaluation-executor-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = merge(var.tags, { Name = "${local.name_prefix}-evaluation-executor-role" })
}

resource "aws_iam_role_policy_attachment" "evaluation_executor_basic" {
  role       = aws_iam_role.evaluation_executor.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "evaluation_executor_xray" {
  role       = aws_iam_role.evaluation_executor.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "evaluation_executor" {
  name = "${local.name_prefix}-evaluation-executor-policy"
  role = aws_iam_role.evaluation_executor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          var.evaluators_table_arn,
          "${var.evaluators_table_arn}/index/*"
        ]
      },
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.evaluations.arn,
          "${aws_s3_bucket.evaluations.arn}/*"
        ]
      },
      {
        Sid      = "SQSConsumeMessages"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.evaluation.arn]
      },
      {
        Sid    = "BedrockAgentCoreAccess"
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeForUser",
          "bedrock-agentcore:StopRuntimeSession",
          "bedrock-agentcore:ListAgentRuntimes",
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
          "bedrock-agentcore-control:ListAgentRuntimes",
          "bedrock-agentcore-control:GetAgentRuntimeEndpoint"
        ]
        Resource = ["*"]
      },
      {
        Sid    = "BedrockModelInvocation"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:inference-profile/*"
        ]
      },
      {
        Sid      = "AppSyncGraphQL"
        Effect   = "Allow"
        Action   = ["appsync:GraphQL"]
        Resource = ["arn:aws:appsync:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:apis/${var.appsync_api_id}/*"]
      },
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}
