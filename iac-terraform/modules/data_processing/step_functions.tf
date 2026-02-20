# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Step Functions State Machine for Data Processing Pipeline
#
# Creates:
# - State machine with JSONata query language
# - CloudWatch Log Group for state machine logs
# - IAM role with permissions for S3, DynamoDB, Lambda, Transcribe
# -------------------------------------------------------------------------

# CloudWatch Log Group for Step Functions
resource "aws_cloudwatch_log_group" "state_machine" {
  # checkov:skip=CKV_AWS_338:365 days retention implemented
  name              = "/aws/${var.prefix}/states/processData/logs"
  retention_in_days = 365
  kms_key_id        = var.kms_key_arn

  tags = var.tags
}

# State Machine Definition with substitutions
locals {
  # Read the state machine definition and perform substitutions
  state_machine_definition = templatefile(
    "${path.module}/../../../lib/data-processing/state-machines/data-processing.json",
    {
      tableDocumentProcessingState = aws_dynamodb_table.document_state.arn
      lambdaCreateMetadataFile     = aws_lambda_function.create_metadata_file.arn
      lambdaReadTranscribe         = aws_lambda_function.transcribe_read.arn
      lambdaReadJson               = aws_lambda_function.json_read.arn
    }
  )
}

# Step Functions State Machine
resource "aws_sfn_state_machine" "data_processing" {
  name     = "${var.prefix}-processData"
  role_arn = aws_iam_role.state_machine.arn

  definition = local.state_machine_definition

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.state_machine.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = var.tags
}

# IAM Role for Step Functions
resource "aws_iam_role" "state_machine" {
  name = "${var.prefix}-sfn-data-processing-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "states.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

# IAM Policy for Step Functions
resource "aws_iam_role_policy" "state_machine" {
  name = "${var.prefix}-sfn-data-processing-policy"
  role = aws_iam_role.state_machine.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:CopyObject"
        ]
        Resource = [
          aws_s3_bucket.data.arn,
          "${aws_s3_bucket.data.arn}/*"
        ]
      },
      {
        Sid    = "S3ListBucket"
        Effect = "Allow"
        Action = [
          "s3:ListObjectsV2"
        ]
        Resource = [aws_s3_bucket.data.arn]
      },
      {
        Sid    = "S3DeleteObjects"
        Effect = "Allow"
        Action = [
          "s3:DeleteObjects"
        ]
        Resource = ["${aws_s3_bucket.data.arn}/*"]
      },
      {
        Sid    = "DynamoDBReadWrite"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [aws_dynamodb_table.document_state.arn]
      },
      {
        Sid    = "LambdaInvoke"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.create_metadata_file.arn,
          aws_lambda_function.transcribe_read.arn,
          aws_lambda_function.json_read.arn
        ]
      },
      {
        Sid    = "Transcribe"
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
          "transcribe:ListTranscriptionJobs",
          "transcribe:TagResource"
        ]
        Resource = ["arn:aws:transcribe:${local.region}:${local.account_id}:*"]
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
          "logs:PutLogEvents",
          "logs:CreateLogStream"
        ]
        Resource = "*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets"
        ]
        Resource = "*"
      },
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}
