# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# SQS Queues for Data Processing Pipeline
#
# Creates:
# - Pipeline start queue (triggered by EventBridge S3 events)
# - Dead letter queue for failed messages
# -------------------------------------------------------------------------

# Dead Letter Queue for Pipeline Start
resource "aws_sqs_queue" "pipeline_start_dlq" {
  name = "${var.prefix}-startPipeline-dlq"

  message_retention_seconds = 1209600 # 14 days
  kms_master_key_id         = var.kms_key_arn

  tags = var.tags
}

# Pipeline Start Queue
resource "aws_sqs_queue" "pipeline_start" {
  name = "${var.prefix}-startPipeline-queue"

  visibility_timeout_seconds = 180    # 3 minutes
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 0
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.pipeline_start_dlq.arn
    maxReceiveCount     = 3
  })

  tags = var.tags
}

# SQS Queue Policy - Allow EventBridge to send messages
resource "aws_sqs_queue_policy" "pipeline_start" {
  queue_url = aws_sqs_queue.pipeline_start.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEventBridgeSendMessage"
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action = [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = aws_sqs_queue.pipeline_start.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = "arn:aws:events:${local.region}:${local.account_id}:rule/*"
          }
        }
      }
    ]
  })
}
