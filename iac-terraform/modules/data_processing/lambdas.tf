# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Lambda Functions for Data Processing Pipeline
#
# Creates:
# - pipeline-start: Triggers Step Functions from SQS
# - create-metadata-file: Creates KB metadata files
# - transcribe-read: Parses Transcribe output
# - json-read: Parses JSON files
# -------------------------------------------------------------------------

# Lambda architecture mapping
locals {
  lambda_architectures = {
    "arm64"  = ["arm64"]
    "x86_64" = ["x86_64"]
  }
}

# -----------------------------------------------------------------------------
# Lambda: Pipeline Start
# Triggered by SQS to start Step Functions execution
# -----------------------------------------------------------------------------

data "archive_file" "pipeline_start" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lib/data-processing/functions/pipeline-start"
  output_path = "${path.module}/../../../iac-terraform/build/data_processing_pipeline_start.zip"
}

resource "aws_lambda_function" "pipeline_start" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not needed - SQS trigger already has DLQ
  # checkov:skip=CKV_AWS_117:VPC not required for Step Functions invocation
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  function_name = "${var.prefix}-dataProcessing-startPipeline"
  description   = "Triggers Step Functions state machine from SQS events"

  filename         = data.archive_file.pipeline_start.output_path
  source_code_hash = data.archive_file.pipeline_start.output_base64sha256

  runtime       = var.python_runtime
  handler       = "index.handler"
  architectures = local.lambda_architectures[var.lambda_architecture]
  timeout       = 60
  memory_size   = 128

  role = aws_iam_role.lambda_pipeline_start.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn
  ]

  environment {
    variables = {
      STATE_MACHINE_ARN       = aws_sfn_state_machine.data_processing.arn
      LOG_LEVEL               = "INFO"
      POWERTOOLS_SERVICE_NAME = "${var.prefix}-dataProcessing-startPipeline"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  tags = var.tags
}

resource "aws_iam_role" "lambda_pipeline_start" {
  name = "${var.prefix}-lambda-pipeline-start-role"

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

resource "aws_iam_role_policy" "lambda_pipeline_start" {
  name = "${var.prefix}-lambda-pipeline-start-policy"
  role = aws_iam_role.lambda_pipeline_start.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartStepFunctions"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = [aws_sfn_state_machine.data_processing.arn]
      },
      {
        Sid    = "SQSAccess"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [aws_sqs_queue.pipeline_start.arn]
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
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}

# SQS Event Source Mapping for Pipeline Start Lambda
resource "aws_lambda_event_source_mapping" "pipeline_start_sqs" {
  event_source_arn                   = aws_sqs_queue.pipeline_start.arn
  function_name                      = aws_lambda_function.pipeline_start.arn
  batch_size                         = 20
  maximum_batching_window_in_seconds = 10
  enabled                            = true
}

# -----------------------------------------------------------------------------
# Lambda: Create Metadata File
# Creates metadata files for Knowledge Base
# -----------------------------------------------------------------------------

data "archive_file" "create_metadata_file" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lib/data-processing/functions/create-metadata-file"
  output_path = "${path.module}/../../../iac-terraform/build/data_processing_create_metadata_file.zip"
}

resource "aws_lambda_function" "create_metadata_file" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not needed - Step Functions handles retries
  # checkov:skip=CKV_AWS_117:VPC not required for S3/DynamoDB access
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  function_name = "${var.prefix}-dataProcessing-createMetadataFile"
  description   = "Creates metadata files for Knowledge Base ingestion"

  filename         = data.archive_file.create_metadata_file.output_path
  source_code_hash = data.archive_file.create_metadata_file.output_base64sha256

  runtime       = var.python_runtime
  handler       = "index.handler"
  architectures = local.lambda_architectures[var.lambda_architecture]
  timeout       = 60
  memory_size   = 128

  role = aws_iam_role.lambda_create_metadata_file.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn
  ]

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.document_state.name
      LOG_LEVEL               = "INFO"
      POWERTOOLS_SERVICE_NAME = "${var.prefix}-dataProcessing-createMetadataFile"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  tags = var.tags
}

resource "aws_iam_role" "lambda_create_metadata_file" {
  name = "${var.prefix}-lambda-create-metadata-role"

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

resource "aws_iam_role_policy" "lambda_create_metadata_file" {
  name = "${var.prefix}-lambda-create-metadata-policy"
  role = aws_iam_role.lambda_create_metadata_file.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBRead"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Resource = [aws_dynamodb_table.document_state.arn]
      },
      {
        Sid    = "S3Write"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = ["${aws_s3_bucket.data.arn}/*"]
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
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Lambda: Transcribe Read
# Parses Amazon Transcribe output to text
# -----------------------------------------------------------------------------

data "archive_file" "transcribe_read" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lib/data-processing/functions/transcribe-read"
  output_path = "${path.module}/../../../iac-terraform/build/data_processing_transcribe_read.zip"
}

resource "aws_lambda_function" "transcribe_read" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not needed - Step Functions handles retries
  # checkov:skip=CKV_AWS_117:VPC not required for S3 access
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  function_name = "${var.prefix}-dataProcessing-readTranscribe"
  description   = "Parses Amazon Transcribe output to text"

  filename         = data.archive_file.transcribe_read.output_path
  source_code_hash = data.archive_file.transcribe_read.output_base64sha256

  runtime       = var.python_runtime
  handler       = "index.handler"
  architectures = local.lambda_architectures[var.lambda_architecture]
  timeout       = 60
  memory_size   = 256

  role = aws_iam_role.lambda_transcribe_read.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn
  ]

  environment {
    variables = {
      LOG_LEVEL               = "INFO"
      POWERTOOLS_SERVICE_NAME = "${var.prefix}-dataProcessing-readTranscribe"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  tags = var.tags
}

resource "aws_iam_role" "lambda_transcribe_read" {
  name = "${var.prefix}-lambda-transcribe-read-role"

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

resource "aws_iam_role_policy" "lambda_transcribe_read" {
  name = "${var.prefix}-lambda-transcribe-read-policy"
  role = aws_iam_role.lambda_transcribe_read.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = ["${aws_s3_bucket.data.arn}/*"]
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
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Lambda: JSON Read
# Parses formatted JSON files to text
# -----------------------------------------------------------------------------

data "archive_file" "json_read" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lib/data-processing/functions/json-read"
  output_path = "${path.module}/../../../iac-terraform/build/data_processing_json_read.zip"
}

resource "aws_lambda_function" "json_read" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not needed - Step Functions handles retries
  # checkov:skip=CKV_AWS_117:VPC not required for S3 access
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  function_name = "${var.prefix}-dataProcessing-readJson"
  description   = "Parses formatted JSON files to text"

  filename         = data.archive_file.json_read.output_path
  source_code_hash = data.archive_file.json_read.output_base64sha256

  runtime       = var.python_runtime
  handler       = "index.handler"
  architectures = local.lambda_architectures[var.lambda_architecture]
  timeout       = 60
  memory_size   = 256

  role = aws_iam_role.lambda_json_read.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn
  ]

  environment {
    variables = {
      LOG_LEVEL               = "INFO"
      POWERTOOLS_SERVICE_NAME = "${var.prefix}-dataProcessing-readJson"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  tags = var.tags
}

resource "aws_iam_role" "lambda_json_read" {
  name = "${var.prefix}-lambda-json-read-role"

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

resource "aws_iam_role_policy" "lambda_json_read" {
  name = "${var.prefix}-lambda-json-read-policy"
  role = aws_iam_role.lambda_json_read.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = ["${aws_s3_bucket.data.arn}/*"]
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
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}
