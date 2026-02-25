/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# Root Module Outputs
# Re-exports outputs from child modules for easy access
# Equivalent to CDK CfnOutput statements
# -----------------------------------------------------------------------------

# Authentication outputs
output "user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = module.authentication.user_pool_id
}

output "user_pool_arn" {
  description = "The ARN of the Cognito User Pool"
  value       = module.authentication.user_pool_arn
}

output "identity_pool_id" {
  description = "The ID of the Cognito Identity Pool"
  value       = module.authentication.identity_pool_id
}

output "user_pool_client_id" {
  description = "The ID of the Cognito User Pool Client (UserPoolWebClientId)"
  value       = module.authentication.user_pool_client_id
}

output "user_pool_link" {
  description = "Direct link to the Cognito User Pool in AWS Console"
  value       = module.authentication.user_pool_link
}

output "user_pool_endpoint" {
  description = "The endpoint of the Cognito User Pool (for OAuth/OIDC)"
  value       = module.authentication.user_pool_endpoint
}

output "authenticated_role_arn" {
  description = "ARN of the IAM role for authenticated Cognito users"
  value       = module.authentication.authenticated_role_arn
}

# -----------------------------------------------------------------------------
# Shared Module Outputs
# Lambda layers and common configuration for Lambda functions
# -----------------------------------------------------------------------------

output "powertools_layer_arn" {
  description = "ARN of the AWS Lambda Powertools layer"
  value       = module.shared.powertools_layer_arn
}

output "boto3_layer_arn" {
  description = "ARN of the custom boto3/botocore layer"
  value       = module.shared.boto3_layer_arn
}

output "genai_core_layer_arn" {
  description = "ARN of the GenAI Core shared library layer"
  value       = module.shared.genai_core_layer_arn
}

output "all_layer_arns" {
  description = "List of all Lambda layer ARNs"
  value       = module.shared.all_layer_arns
}

output "python_runtime" {
  description = "Python runtime for Lambda functions"
  value       = module.shared.python_runtime
}

output "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64)"
  value       = module.shared.lambda_architecture
}

# -----------------------------------------------------------------------------
# Agent Core Module Outputs
# DynamoDB tables, ECR repository, and AgentCore Runtime resources
# -----------------------------------------------------------------------------

output "agent_runtime_config_table_name" {
  description = "Name of the DynamoDB table storing agent runtime configurations"
  value       = module.agent_core.agent_runtime_config_table_name
}

output "tool_registry_table_name" {
  description = "Name of the DynamoDB table storing tool registry"
  value       = module.agent_core.tool_registry_table_name
}

output "mcp_server_registry_table_name" {
  description = "Name of the DynamoDB table storing MCP server registry"
  value       = module.agent_core.mcp_server_registry_table_name
}

output "agent_summary_table_name" {
  description = "Name of the DynamoDB table storing agent summaries"
  value       = module.agent_core.agent_summary_table_name
}

output "agent_tools_topic_arn" {
  description = "ARN of the SNS topic for agent tools messaging"
  value       = module.agent_core.agent_tools_topic_arn
}

output "ecr_repository_url" {
  description = "URL of the ECR repository for agent runtime container images"
  value       = module.agent_core.ecr_repository_url
}

output "agent_core_container_uri" {
  description = "Full container image URI for the agent runtime"
  value       = module.agent_core.container_uri
}

output "docker_image_tag" {
  description = "Content-based Docker image tag (derived from hash of Docker source files). Use this tag when building images with build-image.sh."
  value       = module.agent_core.docker_image_tag
}

output "swarm_ecr_repository_url" {
  description = "URL of the ECR repository for swarm agent runtime container images"
  value       = module.agent_core.swarm_ecr_repository_url
}

output "swarm_container_uri" {
  description = "Full container image URI for the swarm agent runtime"
  value       = module.agent_core.swarm_container_uri
}

output "swarm_docker_image_tag" {
  description = "Content-based Docker image tag for the swarm container. Use this tag when building swarm images with build-image.sh."
  value       = module.agent_core.swarm_docker_image_tag
}

output "agent_core_execution_role_arn" {
  description = "ARN of the IAM execution role for Bedrock AgentCore"
  value       = module.agent_core.execution_role_arn
}

output "default_agent_runtime_id" {
  description = "ID of the default AgentCore runtime (null if not configured)"
  value       = module.agent_core.agent_runtime_id
}

output "default_agent_memory_id" {
  description = "ID of the default AgentCore memory (null if not configured)"
  value       = module.agent_core.memory_id
}

# -----------------------------------------------------------------------------
# User Interface Module Outputs
# CloudFront distribution and website bucket information
# -----------------------------------------------------------------------------

output "website_url" {
  description = "Full HTTPS URL of the deployed website"
  value       = module.user_interface.website_url
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.user_interface.distribution_id
}

output "cloudfront_distribution_domain" {
  description = "CloudFront distribution domain name"
  value       = module.user_interface.distribution_domain_name
}

output "website_bucket_name" {
  description = "Name of the S3 bucket hosting the website"
  value       = module.user_interface.website_bucket_name
}

# -----------------------------------------------------------------------------
# Data Processing Module Outputs (Optional)
# Available when data_processing module is enabled
# -----------------------------------------------------------------------------

output "data_bucket_name" {
  description = "Name of the S3 data bucket for document upload"
  value       = var.data_processing != null ? module.data_processing[0].data_bucket_name : null
}

output "data_processing_state_machine_arn" {
  description = "ARN of the data processing Step Functions state machine"
  value       = var.data_processing != null ? module.data_processing[0].state_machine_arn : null
}

# -----------------------------------------------------------------------------
# Knowledge Base Module Outputs (Optional)
# Available when both knowledge_base and data_processing modules are enabled
# -----------------------------------------------------------------------------

output "knowledge_base_id" {
  description = "ID of the Bedrock Knowledge Base (set this in terraform.tfvars as knowledge_base_id for retrieve_from_kb tool)"
  value       = var.knowledge_base != null && var.data_processing != null ? module.knowledge_base.knowledge_base_id : null
}

output "knowledge_base_arn" {
  description = "ARN of the Bedrock Knowledge Base"
  value       = var.knowledge_base != null && var.data_processing != null ? module.knowledge_base.knowledge_base_arn : null
}

output "opensearch_collection_endpoint" {
  description = "Endpoint of the OpenSearch Serverless collection (vector store)"
  value       = var.knowledge_base != null && var.data_processing != null ? module.knowledge_base.collection_endpoint : null
}

# -----------------------------------------------------------------------------
# Observability Module Outputs (Optional)
# Available when observability module is enabled
# -----------------------------------------------------------------------------

output "observability_dashboard_url" {
  description = "URL to the CloudWatch Dashboard for AgentCore observability"
  value       = var.observability != null ? module.observability[0].dashboard_url : null
}

output "observability_dashboard_name" {
  description = "Name of the CloudWatch Dashboard"
  value       = var.observability != null ? module.observability[0].dashboard_name : null
}

output "transaction_search_enabled" {
  description = "Whether X-Ray Transaction Search is enabled"
  value       = var.observability != null ? module.observability[0].transaction_search_enabled : null
}
