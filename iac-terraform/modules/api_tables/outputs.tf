/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
API Tables Module - Outputs
*/

# -----------------------------------------------------------------------------
# Sessions Table Outputs
# -----------------------------------------------------------------------------

output "sessions_table_name" {
  description = "Name of the sessions DynamoDB table"
  value       = aws_dynamodb_table.sessions.name
}

output "sessions_table_arn" {
  description = "ARN of the sessions DynamoDB table"
  value       = aws_dynamodb_table.sessions.arn
}

output "sessions_table_by_user_index" {
  description = "Name of the byUserId GSI on the sessions table"
  value       = "byUserId"
}

# -----------------------------------------------------------------------------
# Favorite Runtime Table Outputs
# -----------------------------------------------------------------------------

output "favorite_runtime_table_name" {
  description = "Name of the favorite runtime DynamoDB table"
  value       = aws_dynamodb_table.favorite_runtime.name
}

output "favorite_runtime_table_arn" {
  description = "ARN of the favorite runtime DynamoDB table"
  value       = aws_dynamodb_table.favorite_runtime.arn
}
