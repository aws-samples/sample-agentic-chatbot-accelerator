/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
HTTP API Resolver Module - Outputs
*/

# -----------------------------------------------------------------------------
# Lambda Function Outputs
# -----------------------------------------------------------------------------

output "lambda_function_name" {
  description = "Name of the HTTP API resolver Lambda function"
  value       = aws_lambda_function.http_resolver.function_name
}

output "lambda_function_arn" {
  description = "ARN of the HTTP API resolver Lambda function"
  value       = aws_lambda_function.http_resolver.arn
}

output "lambda_role_arn" {
  description = "ARN of the Lambda execution role"
  value       = aws_iam_role.http_resolver.arn
}

# -----------------------------------------------------------------------------
# AppSync Data Source Outputs
# -----------------------------------------------------------------------------

output "lambda_datasource_name" {
  description = "Name of the Lambda AppSync data source"
  value       = aws_appsync_datasource.lambda_resolver.name
}

output "dynamodb_datasource_name" {
  description = "Name of the DynamoDB AppSync data source"
  value       = aws_appsync_datasource.favorites_dynamodb.name
}

# -----------------------------------------------------------------------------
# Operations Handled
# -----------------------------------------------------------------------------

output "query_operations" {
  description = "List of Query operations handled by this module"
  value       = local.filtered_query_operations
}

output "mutation_operations" {
  description = "List of Mutation operations handled by this module"
  value       = local.filtered_mutation_operations
}
