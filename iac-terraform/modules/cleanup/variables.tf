/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Cleanup Module - Variables
*/

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "prefix" {
  description = "Prefix for resource names (typically environment-stack, e.g., 'aca-dev')"
  type        = string
}

variable "stack_tag" {
  description = "Stack tag value for resource identification (e.g., 'aca')"
  type        = string
}

variable "environment_tag" {
  description = "Environment tag value for resource identification (e.g., 'dev')"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of KMS key for encrypting CloudWatch logs"
  type        = string
}

variable "powertools_layer_arn" {
  description = "ARN of AWS Lambda Powertools layer"
  type        = string
}

variable "boto3_layer_arn" {
  description = "ARN of boto3 Lambda layer"
  type        = string
}

# -----------------------------------------------------------------------------
# Optional Variables
# -----------------------------------------------------------------------------

variable "python_runtime" {
  description = "Python runtime version for Lambda functions"
  type        = string
  default     = "python3.13"
}

variable "lambda_architecture" {
  description = "Lambda architecture (arm64 or x86_64)"
  type        = string
  default     = "arm64"
}

variable "iac_knowledge_base_ids" {
  description = "Comma-separated list of IaC-managed Knowledge Base IDs to preserve during cleanup"
  type        = string
  default     = ""
}

variable "iac_rule_names" {
  description = "Comma-separated list of IaC-managed EventBridge rule names to preserve during cleanup"
  type        = string
  default     = ""
}

variable "kb_inventory_table_name" {
  description = "Name of the Knowledge Base inventory DynamoDB table (optional)"
  type        = string
  default     = ""
}

variable "kb_inventory_table_arn" {
  description = "ARN of the Knowledge Base inventory DynamoDB table (optional)"
  type        = string
  default     = ""
}

variable "kb_enabled" {
  description = "Whether knowledge base module is enabled (used for count to avoid unknown value issues)"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags for resources"
  type        = map(string)
  default     = {}
}
