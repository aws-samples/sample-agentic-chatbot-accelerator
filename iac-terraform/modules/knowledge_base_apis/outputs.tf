/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Knowledge Base APIs Module - Outputs
*/

# -----------------------------------------------------------------------------
# Lambda Outputs
# -----------------------------------------------------------------------------

output "lambda_function_arn" {
  description = "ARN of the Knowledge Base resolver Lambda function"
  value       = aws_lambda_function.kb_resolver.arn
}

output "lambda_function_name" {
  description = "Name of the Knowledge Base resolver Lambda function"
  value       = aws_lambda_function.kb_resolver.function_name
}

# -----------------------------------------------------------------------------
# Operations List
# Used by http_api_resolver to exclude these operations
# -----------------------------------------------------------------------------

output "operations" {
  description = "List of GraphQL operation field names handled by this resolver"
  value       = [for op in local.kb_operations : op.field]
}
