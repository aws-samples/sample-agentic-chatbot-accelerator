/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Lambdas Sub-module - Outputs
*/

# -----------------------------------------------------------------------------
# Main Resolver Lambda
# -----------------------------------------------------------------------------

output "agent_core_resolver_function_name" {
  description = "Name of the main agent core resolver Lambda function"
  value       = aws_lambda_function.agent_core_resolver.function_name
}

output "agent_core_resolver_function_arn" {
  description = "ARN of the main agent core resolver Lambda function"
  value       = aws_lambda_function.agent_core_resolver.arn
}

output "agent_core_resolver_role_arn" {
  description = "ARN of the main agent core resolver Lambda role"
  value       = aws_iam_role.agent_core_resolver.arn
}

output "agent_core_resolver_role_name" {
  description = "Name of the main agent core resolver Lambda role"
  value       = aws_iam_role.agent_core_resolver.name
}

# -----------------------------------------------------------------------------
# Step Function Helper Lambdas (Map output for flexibility)
# -----------------------------------------------------------------------------

output "step_function_lambda_arns" {
  description = "Map of Step Function helper Lambda ARNs"
  value = merge(
    { for k, v in aws_lambda_function.step_function_lambdas : k => v.arn },
    { create_runtime_version = aws_lambda_function.create_runtime_version.arn }
  )
}

output "step_function_lambda_function_names" {
  description = "Map of Step Function helper Lambda function names"
  value = merge(
    { for k, v in aws_lambda_function.step_function_lambdas : k => v.function_name },
    { create_runtime_version = aws_lambda_function.create_runtime_version.function_name }
  )
}

# -----------------------------------------------------------------------------
# Specific Lambda ARNs (for Step Function definitions)
# -----------------------------------------------------------------------------

output "delete_endpoint_function_arn" {
  description = "ARN of the delete endpoint Lambda"
  value       = aws_lambda_function.step_function_lambdas["delete_endpoint"].arn
}

output "check_delete_endpoint_function_arn" {
  description = "ARN of the check delete endpoint Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_delete_endpoint"].arn
}

output "list_endpoints_function_arn" {
  description = "ARN of the list endpoints Lambda"
  value       = aws_lambda_function.step_function_lambdas["list_endpoints"].arn
}

output "delete_runtime_function_arn" {
  description = "ARN of the delete runtime Lambda"
  value       = aws_lambda_function.step_function_lambdas["delete_runtime"].arn
}

output "check_delete_runtime_function_arn" {
  description = "ARN of the check delete runtime Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_delete_runtime"].arn
}

output "check_exist_memory_function_arn" {
  description = "ARN of the check exist memory Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_exist_memory"].arn
}

output "delete_memory_function_arn" {
  description = "ARN of the delete memory Lambda"
  value       = aws_lambda_function.step_function_lambdas["delete_memory"].arn
}

output "check_delete_memory_function_arn" {
  description = "ARN of the check delete memory Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_delete_memory"].arn
}

output "create_memory_function_arn" {
  description = "ARN of the create memory Lambda"
  value       = aws_lambda_function.step_function_lambdas["create_memory"].arn
}

output "check_create_memory_function_arn" {
  description = "ARN of the check create memory Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_create_memory"].arn
}

output "create_runtime_version_function_arn" {
  description = "ARN of the create runtime version Lambda"
  value       = aws_lambda_function.create_runtime_version.arn
}

output "check_create_runtime_function_arn" {
  description = "ARN of the check create runtime Lambda"
  value       = aws_lambda_function.step_function_lambdas["check_create_runtime"].arn
}

output "remove_references_function_arn" {
  description = "ARN of the remove runtime references Lambda"
  value       = aws_lambda_function.step_function_lambdas["remove_references"].arn
}

# -----------------------------------------------------------------------------
# Notify Runtime Update Lambda (Node.js)
# -----------------------------------------------------------------------------

output "notify_runtime_update_function_name" {
  description = "Name of the notify runtime update Lambda function"
  value       = aws_lambda_function.notify_runtime_update.function_name
}

output "notify_runtime_update_function_arn" {
  description = "ARN of the notify runtime update Lambda function"
  value       = aws_lambda_function.notify_runtime_update.arn
}
