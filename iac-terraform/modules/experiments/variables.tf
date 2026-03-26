/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

# -----------------------------------------------------------------------------
# VPC Configuration
# -----------------------------------------------------------------------------

variable "vpc_id" {
  description = "Optional existing VPC ID to use for Batch compute. If omitted, a new VPC is created."
  type        = string
  default     = null
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
# DynamoDB & S3
# -----------------------------------------------------------------------------

variable "experiments_table_name" {
  description = "Name of the experiments DynamoDB table"
  type        = string
}

variable "experiments_table_arn" {
  description = "ARN of the experiments DynamoDB table"
  type        = string
}

variable "evaluations_bucket_name" {
  description = "Name of the S3 bucket for evaluation/experiment data"
  type        = string
}

variable "evaluations_bucket_arn" {
  description = "ARN of the S3 bucket for evaluation/experiment data"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync
# -----------------------------------------------------------------------------

variable "appsync_api_id" {
  description = "AppSync GraphQL API ID"
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

variable "aws_profile" {
  description = "AWS CLI profile name for local-exec provisioner commands."
  type        = string
  default     = ""
}
