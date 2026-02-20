/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
HTTP API Resolver Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync Configuration
# -----------------------------------------------------------------------------

variable "appsync_api_id" {
  description = "AppSync GraphQL API ID"
  type        = string
}

variable "graphql_schema_path" {
  description = "Path to the GraphQL schema file for parsing operations"
  type        = string
}

# -----------------------------------------------------------------------------
# DynamoDB Tables
# -----------------------------------------------------------------------------

variable "sessions_table_name" {
  description = "Name of the sessions DynamoDB table"
  type        = string
}

variable "sessions_table_arn" {
  description = "ARN of the sessions DynamoDB table"
  type        = string
}

variable "sessions_by_user_index" {
  description = "Name of the byUserId GSI on sessions table"
  type        = string
}

variable "favorite_runtime_table_name" {
  description = "Name of the favorite runtime DynamoDB table"
  type        = string
}

variable "favorite_runtime_table_arn" {
  description = "ARN of the favorite runtime DynamoDB table"
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
# Lambda Layers
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

# -----------------------------------------------------------------------------
# Lambda Configuration
# -----------------------------------------------------------------------------

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

variable "lambda_timeout_seconds" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 900 # 15 minutes
}

variable "lambda_memory_size" {
  description = "Lambda memory size in MB"
  type        = number
  default     = 512
}

# -----------------------------------------------------------------------------
# Operations to Exclude
# -----------------------------------------------------------------------------

variable "operations_to_exclude" {
  description = "List of GraphQL operations handled by other modules"
  type        = list(string)
  default     = []
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
