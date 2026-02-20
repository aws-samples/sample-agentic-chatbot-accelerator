/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - State Machines Sub-module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

# -----------------------------------------------------------------------------
# Lambda Function ARNs (from lambdas sub-module)
# -----------------------------------------------------------------------------

variable "delete_endpoint_function_arn" {
  description = "ARN of the delete endpoint Lambda"
  type        = string
}

variable "check_delete_endpoint_function_arn" {
  description = "ARN of the check delete endpoint Lambda"
  type        = string
}

variable "list_endpoints_function_arn" {
  description = "ARN of the list endpoints Lambda"
  type        = string
}

variable "delete_runtime_function_arn" {
  description = "ARN of the delete runtime Lambda"
  type        = string
}

variable "check_delete_runtime_function_arn" {
  description = "ARN of the check delete runtime Lambda"
  type        = string
}

variable "check_exist_memory_function_arn" {
  description = "ARN of the check exist memory Lambda"
  type        = string
}

variable "delete_memory_function_arn" {
  description = "ARN of the delete memory Lambda"
  type        = string
}

variable "check_delete_memory_function_arn" {
  description = "ARN of the check delete memory Lambda"
  type        = string
}

variable "create_memory_function_arn" {
  description = "ARN of the create memory Lambda"
  type        = string
}

variable "check_create_memory_function_arn" {
  description = "ARN of the check create memory Lambda"
  type        = string
}

variable "create_runtime_version_function_arn" {
  description = "ARN of the create runtime version Lambda"
  type        = string
}

variable "check_create_runtime_function_arn" {
  description = "ARN of the check create runtime Lambda"
  type        = string
}

variable "remove_references_function_arn" {
  description = "ARN of the remove runtime references Lambda"
  type        = string
}

variable "notify_runtime_update_function_arn" {
  description = "ARN of the notify runtime update Lambda"
  type        = string
}

# -----------------------------------------------------------------------------
# DynamoDB Tables
# -----------------------------------------------------------------------------

variable "agent_core_summary_table_arn" {
  description = "ARN of the agent core summary DynamoDB table"
  type        = string
}

variable "agent_core_runtime_table_arn" {
  description = "ARN of the agent core runtime versions DynamoDB table"
  type        = string
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
