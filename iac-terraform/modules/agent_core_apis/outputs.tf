/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Parent Module - Outputs
*/

# -----------------------------------------------------------------------------
# Lambda Outputs
# -----------------------------------------------------------------------------

output "agent_core_resolver_function_name" {
  description = "Name of the main agent core resolver Lambda function"
  value       = module.lambdas.agent_core_resolver_function_name
}

output "agent_core_resolver_function_arn" {
  description = "ARN of the main agent core resolver Lambda function"
  value       = module.lambdas.agent_core_resolver_function_arn
}

output "notify_runtime_update_function_arn" {
  description = "ARN of the notify runtime update Lambda function"
  value       = module.lambdas.notify_runtime_update_function_arn
}

# -----------------------------------------------------------------------------
# Step Function Outputs
# -----------------------------------------------------------------------------

output "delete_endpoints_state_machine_arn" {
  description = "ARN of the delete endpoints Step Function"
  value       = module.state_machines.delete_endpoints_state_machine_arn
}

output "delete_runtime_state_machine_arn" {
  description = "ARN of the delete runtime Step Function"
  value       = module.state_machines.delete_runtime_state_machine_arn
}

output "create_runtime_state_machine_arn" {
  description = "ARN of the create runtime Step Function"
  value       = module.state_machines.create_runtime_state_machine_arn
}

# -----------------------------------------------------------------------------
# AppSync Resolver Outputs
# -----------------------------------------------------------------------------

output "operations" {
  description = "List of GraphQL operations handled by this module"
  value       = module.resolvers.operations
}

output "lambda_datasource_name" {
  description = "Name of the Lambda AppSync data source"
  value       = module.resolvers.lambda_datasource_name
}
