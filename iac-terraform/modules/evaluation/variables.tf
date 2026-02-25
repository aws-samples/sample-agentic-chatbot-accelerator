/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - Input Variables
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
# DynamoDB Tables
# -----------------------------------------------------------------------------

variable "evaluators_table_name" {
  description = "Name of the evaluators DynamoDB table"
  type        = string
}

variable "evaluators_table_arn" {
  description = "ARN of the evaluators DynamoDB table"
  type        = string
}

variable "by_user_id_index" {
  description = "Name of the byUserId GSI on sessions table"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync
# -----------------------------------------------------------------------------

variable "appsync_api_id" {
  description = "AppSync GraphQL API ID"
  type        = string
}

variable "graphql_url" {
  description = "AppSync GraphQL endpoint URL"
  type        = string
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
