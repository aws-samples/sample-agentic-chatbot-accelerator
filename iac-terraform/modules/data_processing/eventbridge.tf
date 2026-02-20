# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# EventBridge Rules for Data Processing Pipeline
#
# Creates:
# - S3 event rule for Object Created and Object Deleted events
# - Target to SQS queue with message transformation
# -------------------------------------------------------------------------

# EventBridge Rule for S3 Data Processing Events
resource "aws_cloudwatch_event_rule" "s3_data_processing" {
  name        = "${var.prefix}-s3DataProcessing"
  description = "Captures S3 object events for data processing pipeline"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created", "Object Deleted"]
    detail = {
      bucket = {
        name = [aws_s3_bucket.data.id]
      }
      object = {
        key = [{
          prefix = "${var.input_prefix}/"
        }]
      }
    }
  })

  tags = var.tags
}

# EventBridge Target - SQS Queue with Input Transformation
resource "aws_cloudwatch_event_target" "s3_to_sqs" {
  rule      = aws_cloudwatch_event_rule.s3_data_processing.name
  target_id = "SendToSQS"
  arn       = aws_sqs_queue.pipeline_start.arn

  # Transform the S3 event into the format expected by the pipeline
  input_transformer {
    input_paths = {
      bucket     = "$.detail.bucket.name"
      key        = "$.detail.object.key"
      time       = "$.time"
      etag       = "$.detail.object.etag"
      detailType = "$.detail-type"
    }

    input_template = <<EOF
{
  "bucket": <bucket>,
  "key": <key>,
  "s3RequestTimestamp": <time>,
  "etag": <etag>,
  "detailType": <detailType>,
  "prefixInput": "${var.input_prefix}",
  "prefixDataSource": "${var.data_source_prefix}/",
  "prefixProcessing": "${var.processing_prefix}",
  "midfixStaging": "${var.staging_midfix}",
  "midfixTranscribe": "${var.transcribe_midfix}",
  "transcribeJobPrefix": "${local.transcribe_job_prefix}",
  "stackName": "${var.prefix}",
  "languageCode": "${var.language_code}"
}
EOF
  }
}
