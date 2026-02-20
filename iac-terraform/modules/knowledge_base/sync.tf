# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Sync Lambda and SQS Queue for Knowledge Base
#
# Equivalent to: createSyncQueue() in lib/knowledge-base/index.ts
# -------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# SQS Dead Letter Queue
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "sync_dlq" {
  count = var.enabled ? 1 : 0

  name                       = "${var.prefix}-syncKnowledgeBase-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 300
  kms_master_key_id          = var.kms_key_arn

  tags = var.tags
}

# -----------------------------------------------------------------------------
# SQS Queue for Sync Pipeline
# Receives events from EventBridge when S3 objects change
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "sync" {
  count = var.enabled ? 1 : 0

  name                       = "${var.prefix}-syncKnowledgeBase-queue"
  visibility_timeout_seconds = 180 # 3 minutes (Lambda timeout * 3)
  message_retention_seconds  = 86400
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sync_dlq[0].arn
    maxReceiveCount     = 3
  })

  tags = var.tags
}

# -----------------------------------------------------------------------------
# SQS Queue Policy for EventBridge
# -----------------------------------------------------------------------------

resource "aws_sqs_queue_policy" "sync" {
  count = var.enabled ? 1 : 0

  queue_url = aws_sqs_queue.sync[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEventBridgeToSendMessage"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.sync[0].arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_cloudwatch_event_rule.s3_data_source[0].arn
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Lambda Function: Sync Knowledge Base
# Triggered by SQS queue, starts Bedrock ingestion jobs
# -----------------------------------------------------------------------------

data "archive_file" "sync_kb" {
  count = var.enabled ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/../../../lib/knowledge-base/functions/sync-knowledgebase"
  output_path = "${path.module}/../../build/sync-knowledgebase.zip"
}

resource "aws_iam_role" "lambda_sync_kb" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-lambda-sync-kb-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "lambda_sync_kb" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-lambda-sync-kb-policy"
  role = aws_iam_role.lambda_sync_kb[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${var.prefix}-syncKnowledgeBase:*"
      },
      {
        Sid    = "SQSAccess"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.sync[0].arn
      },
      {
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [var.kms_key_arn]
      },
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = aws_dynamodb_table.kb_inventory[0].arn
      },
      {
        Sid    = "BedrockKBAccess"
        Effect = "Allow"
        Action = [
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs"
        ]
        Resource = "arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"
      }
    ]
  })
}

resource "aws_lambda_function" "sync_kb" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not needed - SQS trigger already has DLQ
  # checkov:skip=CKV_AWS_117:VPC not required for Bedrock KB access
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  count = var.enabled ? 1 : 0

  function_name = "${var.prefix}-syncKnowledgeBase"
  role          = aws_iam_role.lambda_sync_kb[0].arn
  handler       = "index.handler"
  runtime       = var.python_runtime
  timeout       = 60
  memory_size   = 128

  filename         = data.archive_file.sync_kb[0].output_path
  source_code_hash = data.archive_file.sync_kb[0].output_base64sha256

  architectures = [var.lambda_architecture]

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn
  ]

  environment {
    variables = {
      KNOWLEDGEBASE_TABLE_NAME = aws_dynamodb_table.kb_inventory[0].name
      LOG_LEVEL                = "INFO"
      POWERTOOLS_SERVICE_NAME  = "sync-knowledgebase"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.lambda_sync_kb]
}

# -----------------------------------------------------------------------------
# SQS Event Source Mapping
# Connects SQS queue to Lambda function
# -----------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "sync_kb_sqs" {
  count = var.enabled ? 1 : 0

  event_source_arn                   = aws_sqs_queue.sync[0].arn
  function_name                      = aws_lambda_function.sync_kb[0].arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 10

  function_response_types = ["ReportBatchItemFailures"]
}
