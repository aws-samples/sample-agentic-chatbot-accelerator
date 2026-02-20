# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Variables for Knowledge Base Module using aws-ia/bedrock
# -------------------------------------------------------------------------

variable "prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "enabled" {
  description = "Whether to create the knowledge base resources"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Data Source Configuration
# -----------------------------------------------------------------------------

variable "data_bucket_name" {
  description = "Name of the S3 bucket containing the data source"
  type        = string
}

variable "data_bucket_arn" {
  description = "ARN of the S3 bucket containing the data source"
  type        = string
}

variable "data_source_prefix" {
  description = "S3 prefix for the data source files"
  type        = string
  default     = "data-source"
}

variable "input_prefix" {
  description = "S3 prefix for raw input files (from data processing)"
  type        = string
  default     = "input"
}

# -----------------------------------------------------------------------------
# Embedding Model Configuration
# -----------------------------------------------------------------------------

variable "embedding_model_id" {
  description = "Bedrock embedding model ID (e.g., 'amazon.titan-embed-text-v2:0')"
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "vector_dimension" {
  description = "Vector dimension for the embedding model (1024 for Titan v2, 1536 for v1)"
  type        = number
  default     = 1024
}

# -----------------------------------------------------------------------------
# Chunking Strategy Configuration
# -----------------------------------------------------------------------------

variable "chunking_strategy" {
  description = "Chunking strategy: FIXED_SIZE, HIERARCHICAL, SEMANTIC, or NONE"
  type        = string
  default     = "FIXED_SIZE"

  validation {
    condition     = contains(["FIXED_SIZE", "HIERARCHICAL", "SEMANTIC", "NONE"], var.chunking_strategy)
    error_message = "chunking_strategy must be one of: FIXED_SIZE, HIERARCHICAL, SEMANTIC, NONE"
  }
}

variable "fixed_chunking_config" {
  description = "Configuration for fixed-size chunking"
  type = object({
    max_tokens         = number
    overlap_percentage = number
  })
  default = {
    max_tokens         = 300
    overlap_percentage = 20
  }
}

variable "hierarchical_chunking_config" {
  description = "Configuration for hierarchical chunking"
  type = object({
    overlap_tokens        = number
    max_parent_token_size = number
    max_child_token_size  = number
  })
  default = null
}

variable "semantic_chunking_config" {
  description = "Configuration for semantic chunking"
  type = object({
    buffer_size                     = number
    breakpoint_percentile_threshold = number
    max_tokens                      = number
  })
  default = null
}

# -----------------------------------------------------------------------------
# Knowledge Base Configuration
# -----------------------------------------------------------------------------

variable "description" {
  description = "Description for the knowledge base"
  type        = string
  default     = "Knowledge Base for searching helpful information."
}

# -----------------------------------------------------------------------------
# Lambda Configuration (for sync function)
# -----------------------------------------------------------------------------

variable "powertools_layer_arn" {
  description = "ARN of the Powertools Lambda layer"
  type        = string
}

variable "boto3_layer_arn" {
  description = "ARN of the Boto3 Lambda layer"
  type        = string
}

variable "genai_core_layer_arn" {
  description = "ARN of the GenAI core Lambda layer"
  type        = string
}

variable "python_runtime" {
  description = "Python runtime for Lambda functions"
  type        = string
  default     = "python3.13"
}

variable "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64)"
  type        = string
  default     = "x86_64"
}

# -----------------------------------------------------------------------------
# Encryption
# -----------------------------------------------------------------------------

variable "kms_key_arn" {
  description = "ARN of the KMS key for encryption"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
