/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Data Processing Module - Variables

Equivalent to: lib/data-processing/index.ts
*/

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "prefix" {
  description = "Prefix for resource names (e.g., 'aca-dev')"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of KMS key for encryption"
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

variable "genai_core_layer_arn" {
  description = "ARN of genai_core Lambda layer"
  type        = string
}

# -----------------------------------------------------------------------------
# Data Processing Configuration
# -----------------------------------------------------------------------------

variable "input_prefix" {
  description = "S3 prefix for input files (triggers processing)"
  type        = string
  default     = "input"
}

variable "data_source_prefix" {
  description = "S3 prefix for processed files (ready for KB)"
  type        = string
  default     = "data-source"
}

variable "processing_prefix" {
  description = "S3 prefix for intermediate processing files"
  type        = string
  default     = "processing"
}

variable "staging_midfix" {
  description = "Midfix for staging files"
  type        = string
  default     = "staging"
}

variable "transcribe_midfix" {
  description = "Midfix for transcription output"
  type        = string
  default     = "transcribe"
}

variable "language_code" {
  description = "Language code for transcription (use 'auto' for auto-detect)"
  type        = string
  default     = "auto"
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

variable "tags" {
  description = "Additional tags for resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# CORS Configuration
# -----------------------------------------------------------------------------

variable "cors_allowed_origins" {
  description = "List of allowed origins for CORS (e.g., CloudFront domain URL)"
  type        = list(string)
  default     = ["http://localhost:3000"]
}
