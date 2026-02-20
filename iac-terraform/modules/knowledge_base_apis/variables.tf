/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Knowledge Base APIs Module - Input Variables

This module handles Knowledge Base GraphQL operations via AppSync resolvers.
Equivalent to: KnowledgeBaseOps construct in lib/api/knowledge-base.ts
*/

variable "prefix" {
  description = "Prefix for resource names"
  type        = string
}

# -----------------------------------------------------------------------------
# Lambda Configuration
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
# AppSync Configuration
# -----------------------------------------------------------------------------

variable "appsync_api_id" {
  description = "AppSync GraphQL API ID"
  type        = string
}

# -----------------------------------------------------------------------------
# Data Processing Module Resources
# -----------------------------------------------------------------------------

variable "document_table_name" {
  description = "Name of the document state DynamoDB table from data_processing module"
  type        = string
}

variable "document_table_arn" {
  description = "ARN of the document state DynamoDB table from data_processing module"
  type        = string
}

variable "data_bucket_name" {
  description = "Name of the data S3 bucket from data_processing module"
  type        = string
}

variable "data_bucket_arn" {
  description = "ARN of the data S3 bucket from data_processing module"
  type        = string
}

variable "queue_start_pipeline_arn" {
  description = "ARN of the pipeline start SQS queue from data_processing module"
  type        = string
}

# -----------------------------------------------------------------------------
# Knowledge Base Module Resources
# -----------------------------------------------------------------------------

variable "kb_inventory_table_name" {
  description = "Name of the KB inventory DynamoDB table from knowledge_base module"
  type        = string
}

variable "kb_inventory_table_arn" {
  description = "ARN of the KB inventory DynamoDB table from knowledge_base module"
  type        = string
}

variable "kb_role_arn" {
  description = "ARN of the Knowledge Base IAM role from knowledge_base module"
  type        = string
}

variable "collection_id" {
  description = "ID of the OpenSearch Serverless collection from knowledge_base module"
  type        = string
}

variable "collection_arn" {
  description = "ARN of the OpenSearch Serverless collection from knowledge_base module"
  type        = string
}

variable "collection_name" {
  description = "Name of the OpenSearch Serverless collection from knowledge_base module"
  type        = string
}

# -----------------------------------------------------------------------------
# Tags Configuration
# -----------------------------------------------------------------------------

variable "stack_tag" {
  description = "Stack tag for Bedrock resources"
  type        = string
  default     = "aca"
}

variable "environment_tag" {
  description = "Environment tag for Bedrock resources"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Encryption
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
