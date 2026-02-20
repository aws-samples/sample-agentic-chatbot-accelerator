/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'aca-dev')"
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

variable "by_user_id_index" {
  description = "Name of the by-user-id GSI on sessions table"
  type        = string
}

# -----------------------------------------------------------------------------
# SNS Topics
# -----------------------------------------------------------------------------

variable "messages_topic_arn" {
  description = "ARN of the messages SNS topic for publishing responses"
  type        = string
}

variable "agent_tools_topic_arn" {
  description = "ARN of the agent tools SNS topic"
  type        = string
}

# -----------------------------------------------------------------------------
# Tags for IAM Conditions (AgentCore resource scoping)
# -----------------------------------------------------------------------------

variable "stack_tag" {
  description = "Stack tag for Bedrock AgentCore resource scoping"
  type        = string
  default     = "aca"
}

variable "environment_tag" {
  description = "Environment tag for Bedrock AgentCore resource scoping (optional)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# KMS & Tags
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
