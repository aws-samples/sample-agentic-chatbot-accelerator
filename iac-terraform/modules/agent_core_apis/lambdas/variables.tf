/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Lambdas Sub-module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

# -----------------------------------------------------------------------------
# Lambda Layers & Runtime
# -----------------------------------------------------------------------------

variable "powertools_layer_arn" {
  description = "ARN of the Lambda Powertools layer"
  type        = string
}

variable "boto3_layer_arn" {
  description = "ARN of the Boto3 layer"
  type        = string
}

variable "genai_core_layer_arn" {
  description = "ARN of the GenAI Core layer"
  type        = string
}

variable "python_runtime" {
  description = "Python runtime version for Lambda"
  type        = string
  default     = "python3.13"
}

variable "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64)"
  type        = string
  default     = "arm64"
}

# -----------------------------------------------------------------------------
# Container Configuration
# -----------------------------------------------------------------------------

variable "container_uri" {
  description = "ECR image URI for agent core container"
  type        = string
}

# -----------------------------------------------------------------------------
# DynamoDB Tables
# -----------------------------------------------------------------------------

variable "agent_core_runtime_table_name" {
  description = "Name of the agent core runtime versions DynamoDB table"
  type        = string
}

variable "agent_core_runtime_table_arn" {
  description = "ARN of the agent core runtime versions DynamoDB table"
  type        = string
}

variable "agent_core_summary_table_name" {
  description = "Name of the agent core summary DynamoDB table"
  type        = string
}

variable "agent_core_summary_table_arn" {
  description = "ARN of the agent core summary DynamoDB table"
  type        = string
}

variable "tool_registry_table_name" {
  description = "Name of the tool registry DynamoDB table"
  type        = string
}

variable "tool_registry_table_arn" {
  description = "ARN of the tool registry DynamoDB table"
  type        = string
}

variable "mcp_server_registry_table_name" {
  description = "Name of the MCP server registry DynamoDB table"
  type        = string
}

variable "mcp_server_registry_table_arn" {
  description = "ARN of the MCP server registry DynamoDB table"
  type        = string
}

# -----------------------------------------------------------------------------
# IAM Roles
# -----------------------------------------------------------------------------

variable "agent_core_execution_role_arn" {
  description = "ARN of the IAM role for Bedrock AgentCore runtime execution"
  type        = string
}

# -----------------------------------------------------------------------------
# SNS Topics
# -----------------------------------------------------------------------------

variable "agent_tools_topic_arn" {
  description = "ARN of the SNS topic for agent tools"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync (for notify Lambda)
# -----------------------------------------------------------------------------

variable "graphql_url" {
  description = "AppSync GraphQL endpoint URL"
  type        = string
}

variable "appsync_api_id" {
  description = "AppSync GraphQL API ID"
  type        = string
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "stack_tag" {
  description = "Stack tag for Bedrock AgentCore resources"
  type        = string
  default     = "aca"
}

variable "environment_tag" {
  description = "Environment tag for Bedrock AgentCore resources"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# KMS & Other
# -----------------------------------------------------------------------------

variable "kms_key_arn" {
  description = "ARN of the KMS key for encryption"
  type        = string
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# State Machine ARNs (passed from parent to avoid circular dependency)
# -----------------------------------------------------------------------------

variable "create_runtime_state_machine_arn" {
  description = "ARN of the create runtime Step Function state machine"
  type        = string
  default     = ""
}

variable "delete_runtime_state_machine_arn" {
  description = "ARN of the delete runtime Step Function state machine"
  type        = string
  default     = ""
}

variable "delete_endpoints_state_machine_arn" {
  description = "ARN of the delete endpoints Step Function state machine"
  type        = string
  default     = ""
}
