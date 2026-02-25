/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - S3 Buckets & SQS Queues

Architecture: AppSync → Resolver Lambda → SQS → Executor Lambda → DynamoDB/S3

Creates:
- S3 logging bucket for evaluation data access logs
- S3 bucket for evaluation test cases and results
- SQS dead letter queue for failed evaluations
- SQS queue for test case processing
*/

locals {
  name_prefix   = lower(var.prefix)
  functions_dir = "${path.module}/../../../lib/api/functions"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# S3 Logging Bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "evaluations_logging" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for logging
  # checkov:skip=CKV_AWS_145:S3 managed encryption sufficient for logging
  # checkov:skip=CKV_AWS_18:Logging bucket does not need its own access logging
  # checkov:skip=CKV2_AWS_62:Event notifications not needed for logging bucket
  # checkov:skip=CKV2_AWS_61:Lifecycle configuration not needed for logging bucket
  bucket = "${local.name_prefix}-logging-evaluations-${data.aws_region.current.id}-${data.aws_caller_identity.current.account_id}"

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-logging-evaluations"
  })
}

resource "aws_s3_bucket_versioning" "evaluations_logging" {
  bucket = aws_s3_bucket.evaluations_logging.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evaluations_logging" {
  bucket = aws_s3_bucket.evaluations_logging.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "evaluations_logging" {
  bucket                  = aws_s3_bucket.evaluations_logging.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "evaluations_logging" {
  bucket = aws_s3_bucket.evaluations_logging.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceSSL"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.evaluations_logging.arn,
          "${aws_s3_bucket.evaluations_logging.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# S3 Evaluations Bucket
# Stores test case data and evaluation results
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "evaluations" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed
  # checkov:skip=CKV_AWS_145:S3 managed encryption sufficient
  # checkov:skip=CKV2_AWS_62:Event notifications not needed
  # checkov:skip=CKV2_AWS_61:Lifecycle configuration not needed
  bucket = "${local.name_prefix}-evaluations-${data.aws_region.current.id}-${data.aws_caller_identity.current.account_id}"

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluations"
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evaluations" {
  bucket = aws_s3_bucket.evaluations.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "evaluations" {
  bucket                  = aws_s3_bucket.evaluations.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_logging" "evaluations" {
  bucket        = aws_s3_bucket.evaluations.id
  target_bucket = aws_s3_bucket.evaluations_logging.id
  target_prefix = "/aws/${local.name_prefix}/evaluations-bucket/logs"
}

resource "aws_s3_bucket_policy" "evaluations" {
  bucket = aws_s3_bucket.evaluations.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceSSL"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.evaluations.arn,
          "${aws_s3_bucket.evaluations.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# SQS Dead Letter Queue
# Captures failed evaluation test cases after max retries
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "evaluation_dlq" {
  # checkov:skip=CKV_AWS_27:DLQ does not need its own DLQ
  name                      = "${local.name_prefix}-evaluation-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-dlq"
  })
}

resource "aws_sqs_queue_policy" "evaluation_dlq" {
  queue_url = aws_sqs_queue.evaluation_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceSSL"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.evaluation_dlq.arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# SQS Evaluation Queue
# Each message represents a single test case to be evaluated
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "evaluation" {
  name                       = "${local.name_prefix}-evaluation-queue"
  visibility_timeout_seconds = 900     # 15 minutes (match Lambda timeout)
  message_retention_seconds  = 1209600 # 14 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.evaluation_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-queue"
  })
}

resource "aws_sqs_queue_policy" "evaluation" {
  queue_url = aws_sqs_queue.evaluation.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceSSL"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.evaluation.arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}
