/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AppSync Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

variable "user_pool_id" {
  description = "Cognito User Pool ID for authentication"
  type        = string
}

variable "schema_file_path" {
  description = "Path to the GraphQL schema file"
  type        = string
  default     = null
}

variable "schema_content" {
  description = "GraphQL schema content (if not using schema_file_path)"
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch logs (minimum 365 recommended)"
  type        = number
  default     = 365
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for CloudWatch logs encryption (optional)"
  type        = string
  default     = null
}

variable "environment_variables" {
  description = "Environment variables for AppSync resolvers (accessible via ctx.env)"
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
