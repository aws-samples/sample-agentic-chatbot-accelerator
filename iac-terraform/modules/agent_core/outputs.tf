/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# DynamoDB Table Outputs
# -----------------------------------------------------------------------------

output "agent_runtime_config_table_name" {
  description = "Name of the DynamoDB table storing agent runtime configurations"
  value       = aws_dynamodb_table.agent_runtime_config.name
}

output "agent_runtime_config_table_arn" {
  description = "ARN of the DynamoDB table storing agent runtime configurations"
  value       = aws_dynamodb_table.agent_runtime_config.arn
}

output "tool_registry_table_name" {
  description = "Name of the DynamoDB table storing tool registry"
  value       = aws_dynamodb_table.tool_registry.name
}

output "tool_registry_table_arn" {
  description = "ARN of the DynamoDB table storing tool registry"
  value       = aws_dynamodb_table.tool_registry.arn
}

output "mcp_server_registry_table_name" {
  description = "Name of the DynamoDB table storing MCP server registry"
  value       = aws_dynamodb_table.mcp_server_registry.name
}

output "mcp_server_registry_table_arn" {
  description = "ARN of the DynamoDB table storing MCP server registry"
  value       = aws_dynamodb_table.mcp_server_registry.arn
}

output "agent_summary_table_name" {
  description = "Name of the DynamoDB table storing agent summaries"
  value       = aws_dynamodb_table.agent_summary.name
}

output "agent_summary_table_arn" {
  description = "ARN of the DynamoDB table storing agent summaries"
  value       = aws_dynamodb_table.agent_summary.arn
}

# -----------------------------------------------------------------------------
# SNS Topic Outputs
# -----------------------------------------------------------------------------

output "agent_tools_topic_arn" {
  description = "ARN of the SNS topic for agent tools messaging"
  value       = aws_sns_topic.agent_tools.arn
}

output "agent_tools_topic_name" {
  description = "Name of the SNS topic for agent tools messaging"
  value       = aws_sns_topic.agent_tools.name
}

# -----------------------------------------------------------------------------
# ECR Repository Outputs
# -----------------------------------------------------------------------------

output "ecr_repository_url" {
  description = "URL of the ECR repository for agent runtime container images"
  value       = aws_ecr_repository.agent_core.repository_url
}

output "ecr_repository_arn" {
  description = "ARN of the ECR repository"
  value       = aws_ecr_repository.agent_core.arn
}

output "container_uri" {
  description = "Full container image URI for the agent runtime"
  value       = local.container_uri
}

output "docker_image_tag" {
  description = "Content-based Docker image tag (derived from hash of Docker source files)"
  value       = local.content_based_tag
}

# -----------------------------------------------------------------------------
# Swarm ECR Repository Outputs
# -----------------------------------------------------------------------------

output "swarm_ecr_repository_url" {
  description = "URL of the ECR repository for swarm agent runtime container images"
  value       = aws_ecr_repository.swarm_agent_core.repository_url
}

output "swarm_ecr_repository_arn" {
  description = "ARN of the swarm ECR repository"
  value       = aws_ecr_repository.swarm_agent_core.arn
}

output "swarm_container_uri" {
  description = "Full container image URI for the swarm agent runtime"
  value       = local.swarm_container_uri
}

output "swarm_docker_image_tag" {
  description = "Content-based Docker image tag for the swarm container (derived from hash of Docker source files)"
  value       = local.swarm_content_based_tag
}

# -----------------------------------------------------------------------------
# IAM Role Outputs
# -----------------------------------------------------------------------------

output "execution_role_arn" {
  description = "ARN of the IAM execution role for Bedrock AgentCore"
  value       = aws_iam_role.execution.arn
}

output "execution_role_name" {
  description = "Name of the IAM execution role for Bedrock AgentCore"
  value       = aws_iam_role.execution.name
}

# -----------------------------------------------------------------------------
# KMS Key Outputs (pass-through from root module)
# -----------------------------------------------------------------------------

output "kms_key_arn" {
  description = "ARN of the KMS key used for encryption (passed from root module)"
  value       = var.kms_key_arn
}

output "kms_key_id" {
  description = "ID of the KMS key used for encryption (passed from root module)"
  value       = var.kms_key_id
}

# -----------------------------------------------------------------------------
# AgentCore Runtime Outputs (when created)
# -----------------------------------------------------------------------------

output "agent_runtime_id" {
  description = "ID of the default AgentCore runtime (null if not created)"
  value       = var.agent_runtime_config != null ? aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_id : null
}

output "agent_runtime_arn" {
  description = "ARN of the default AgentCore runtime (null if not created)"
  value       = var.agent_runtime_config != null ? aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_arn : null
}

output "agent_runtime_version" {
  description = "Version of the default AgentCore runtime (null if not created)"
  value       = var.agent_runtime_config != null ? aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_version : null
}

output "agent_name" {
  description = "Name of the default agent"
  value       = local.agent_name
}

# -----------------------------------------------------------------------------
# AgentCore Memory Outputs (when created)
# -----------------------------------------------------------------------------

output "memory_id" {
  description = "ID of the default AgentCore memory (null if not created)"
  value       = var.agent_runtime_config != null && var.agent_runtime_config.memory_config != null ? aws_bedrockagentcore_memory.default[0].id : null
}

output "memory_arn" {
  description = "ARN of the default AgentCore memory (null if not created)"
  value       = var.agent_runtime_config != null && var.agent_runtime_config.memory_config != null ? aws_bedrockagentcore_memory.default[0].arn : null
}
