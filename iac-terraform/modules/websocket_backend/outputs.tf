/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
WebSocket Backend Module - Outputs
*/

# -----------------------------------------------------------------------------
# SNS Topic Outputs
# -----------------------------------------------------------------------------

output "messages_topic_arn" {
  description = "ARN of the SNS topic for chat messages"
  value       = aws_sns_topic.messages.arn
}

output "messages_topic_name" {
  description = "Name of the SNS topic for chat messages"
  value       = aws_sns_topic.messages.name
}

# -----------------------------------------------------------------------------
# Lambda Function Outputs
# -----------------------------------------------------------------------------

output "outgoing_handler_function_name" {
  description = "Name of the outgoing message handler Lambda function"
  value       = aws_lambda_function.outgoing_message_handler.function_name
}

output "outgoing_handler_function_arn" {
  description = "ARN of the outgoing message handler Lambda function"
  value       = aws_lambda_function.outgoing_message_handler.arn
}

# -----------------------------------------------------------------------------
# AppSync Data Source Outputs
# -----------------------------------------------------------------------------

output "sns_http_datasource_name" {
  description = "Name of the SNS HTTP AppSync data source"
  value       = aws_appsync_datasource.sns_http.name
}

output "none_datasource_name" {
  description = "Name of the None AppSync data source"
  value       = aws_appsync_datasource.websocket_none.name
}

# -----------------------------------------------------------------------------
# Operations Handled (for exclusion from other resolvers)
# -----------------------------------------------------------------------------

output "operations" {
  description = "List of GraphQL operations handled by this module"
  value       = ["sendQuery", "publishResponse", "receiveMessages"]
}
