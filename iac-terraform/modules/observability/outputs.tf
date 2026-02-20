/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Observability Module - Outputs
*/

# -----------------------------------------------------------------------------
# Dashboard Outputs
# -----------------------------------------------------------------------------

output "dashboard_name" {
  description = "Name of the CloudWatch Dashboard"
  value       = aws_cloudwatch_dashboard.agentcore.dashboard_name
}

output "dashboard_arn" {
  description = "ARN of the CloudWatch Dashboard"
  value       = aws_cloudwatch_dashboard.agentcore.dashboard_arn
}

output "dashboard_url" {
  description = "Direct URL to the CloudWatch Dashboard"
  value       = "https://${data.aws_region.current.id}.console.aws.amazon.com/cloudwatch/home?region=${data.aws_region.current.id}#dashboards:name=${aws_cloudwatch_dashboard.agentcore.dashboard_name}"
}

# -----------------------------------------------------------------------------
# Transaction Search Outputs
# -----------------------------------------------------------------------------

output "transaction_search_enabled" {
  description = "Whether X-Ray Transaction Search is enabled"
  value       = var.enable_transaction_search
}

output "indexing_percentage" {
  description = "X-Ray trace indexing percentage"
  value       = var.indexing_percentage
}
