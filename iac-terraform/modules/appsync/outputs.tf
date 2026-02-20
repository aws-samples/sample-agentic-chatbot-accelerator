/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AppSync Module - Outputs
*/

# -----------------------------------------------------------------------------
# GraphQL API Outputs
# -----------------------------------------------------------------------------

output "api_id" {
  description = "ID of the AppSync GraphQL API"
  value       = aws_appsync_graphql_api.main.id
}

output "api_arn" {
  description = "ARN of the AppSync GraphQL API"
  value       = aws_appsync_graphql_api.main.arn
}

output "graphql_url" {
  description = "GraphQL endpoint URL"
  value       = aws_appsync_graphql_api.main.uris["GRAPHQL"]
}

output "realtime_url" {
  description = "WebSocket URL for real-time subscriptions"
  value       = aws_appsync_graphql_api.main.uris["REALTIME"]
}

output "api_name" {
  description = "Name of the AppSync GraphQL API"
  value       = aws_appsync_graphql_api.main.name
}

# -----------------------------------------------------------------------------
# IAM Role Outputs
# -----------------------------------------------------------------------------

output "logging_role_arn" {
  description = "ARN of the IAM role used for AppSync logging"
  value       = aws_iam_role.appsync_logging.arn
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group Outputs
# -----------------------------------------------------------------------------

output "log_group_name" {
  description = "Name of the CloudWatch log group for AppSync"
  value       = aws_cloudwatch_log_group.appsync.name
}

output "log_group_arn" {
  description = "ARN of the CloudWatch log group for AppSync"
  value       = aws_cloudwatch_log_group.appsync.arn
}
