/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Observability Module - Main Resources

Creates:
- CloudWatch Log Resource Policy for X-Ray Transaction Search
- X-Ray Transaction Search Configuration
- CloudWatch Dashboard for AgentCore metrics

Equivalent to: lib/observability/index.ts
*/

locals {
  name_prefix = lower(var.prefix)
}

# Get current AWS account and region
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# X-Ray Transaction Search (Optional)
# Enables distributed tracing with transaction search capabilities
# Ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search-Cloudformation.html
# -----------------------------------------------------------------------------

# CloudWatch Logs Resource Policy - Allow X-Ray to write spans
resource "aws_cloudwatch_log_resource_policy" "xray_spans" {
  count = var.enable_transaction_search ? 1 : 0

  policy_name = "${local.name_prefix}-TransactionSearchAccess"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TransactionSearchXRayAccess"
        Effect = "Allow"
        Principal = {
          Service = "xray.amazonaws.com"
        }
        Action = "logs:PutLogEvents"
        Resource = [
          "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:aws/spans:*",
          "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/application-signals/data:*"
        ]
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:xray:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
          }
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# X-Ray Transaction Search Config (uses AWSCC provider)
resource "awscc_xray_transaction_search_config" "main" {
  count = var.enable_transaction_search ? 1 : 0

  indexing_percentage = var.indexing_percentage

  depends_on = [aws_cloudwatch_log_resource_policy.xray_spans]
}

# -----------------------------------------------------------------------------
# CloudWatch Dashboard
# Provides observability metrics for AgentCore agents
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "agentcore" {
  dashboard_name = "${local.name_prefix}-agentCore-observability"

  dashboard_body = jsonencode({
    widgets = [
      # Row 1: Latency and Errors
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Agent Response Latency"
          region = data.aws_region.current.id
          metrics = [
            [{ expression = "m1/1000", label = "Bedrock Latency (s)", id = "e1" }],
            ["AWS/Bedrock", "InvocationLatency", { stat = "Average", id = "m1", visible = false }],
            [{ expression = "m2/1000", label = "X-Ray P99 (s)", id = "e2" }],
            ["AWS/X-Ray", "ResponseTime", { stat = "p99", id = "m2", visible = false }]
          ]
          yAxis = {
            left = {
              min   = 0
              label = "Seconds"
            }
          }
          view    = "timeSeries"
          stacked = false
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Error Rate & Faults"
          region = data.aws_region.current.id
          metrics = [
            ["AWS/Bedrock", "InvocationErrors", { stat = "Sum" }],
            ["AWS/X-Ray", "ErrorRate", { stat = "Average" }]
          ]
          yAxis = {
            left = {
              min   = 0
              label = "Count/Percent"
            }
          }
          view    = "timeSeries"
          stacked = false
        }
      },
      # Row 2: Token Usage and Invocations
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Token Usage"
          region = data.aws_region.current.id
          metrics = [
            ["AWS/Bedrock", "InputTokenCount", { stat = "Sum" }],
            ["AWS/Bedrock", "OutputTokenCount", { stat = "Sum" }]
          ]
          yAxis = {
            left = {
              min   = 0
              label = "Tokens"
            }
          }
          view    = "timeSeries"
          stacked = false
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Invocation Volume"
          region = data.aws_region.current.id
          metrics = [
            ["AWS/Bedrock", "Invocations", { stat = "Sum" }]
          ]
          yAxis = {
            left = {
              min   = 0
              label = "Count"
            }
          }
          view    = "timeSeries"
          stacked = false
        }
      }
    ]
  })
}
