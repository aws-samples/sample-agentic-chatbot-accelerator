# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# EventBridge Rules for Knowledge Base S3 Data Source
#
# Triggers sync pipeline when files are added/removed from data source prefix
# -------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "s3_data_source" {
  count = var.enabled ? 1 : 0

  name        = "${var.prefix}-kb-s3DataSource"
  description = "Triggers KB sync when files change in data source prefix"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created", "Object Deleted"]
    detail = {
      bucket = {
        name = [var.data_bucket_name]
      }
      object = {
        key = [{
          prefix = "${var.data_source_prefix}/"
        }]
      }
    }
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "s3_data_source_to_sqs" {
  count = var.enabled ? 1 : 0

  rule      = aws_cloudwatch_event_rule.s3_data_source[0].name
  target_id = "SyncKnowledgeBaseQueue"
  arn       = aws_sqs_queue.sync[0].arn

  input_transformer {
    input_paths = {
      bucket             = "$.detail.bucket.name"
      key                = "$.detail.object.key"
      s3RequestTimestamp = "$.time"
    }

    input_template = <<-EOF
      {
        "bucket": <bucket>,
        "key": <key>,
        "s3RequestTimestamp": <s3RequestTimestamp>,
        "knowledgeBaseId": "${aws_bedrockagent_knowledge_base.main[0].id}",
        "dataSourceId": "${aws_bedrockagent_data_source.s3[0].data_source_id}"
      }
    EOF
  }

  depends_on = [
    aws_bedrockagent_knowledge_base.main,
    aws_bedrockagent_data_source.s3
  ]
}
