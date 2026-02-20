/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Resolvers Sub-module - Outputs
*/

# -----------------------------------------------------------------------------
# AppSync Data Sources
# -----------------------------------------------------------------------------

output "lambda_datasource_name" {
  description = "Name of the Lambda AppSync data source"
  value       = aws_appsync_datasource.agent_core_resolver.name
}

output "none_datasource_name" {
  description = "Name of the None AppSync data source"
  value       = aws_appsync_datasource.agent_factory_none.name
}

# -----------------------------------------------------------------------------
# Operations Handled
# -----------------------------------------------------------------------------

output "operations" {
  description = "List of GraphQL operations handled by this module"
  value = concat(
    [for op in local.lambda_operations : op.field],
    ["publishRuntimeUpdate", "receiveUpdateNotification"]
  )
}

output "lambda_operations" {
  description = "List of Lambda-backed operations"
  value       = [for op in local.lambda_operations : op.field]
}
