/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'aca-dev')"
  type        = string
}

# -----------------------------------------------------------------------------
# Cognito Configuration
# -----------------------------------------------------------------------------

variable "user_pool_id" {
  description = "Cognito User Pool ID"
  type        = string
}

variable "user_pool_client_id" {
  description = "Cognito User Pool Client ID"
  type        = string
}

variable "identity_pool_id" {
  description = "Cognito Identity Pool ID"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync Configuration
# -----------------------------------------------------------------------------

variable "graphql_url" {
  description = "AppSync GraphQL endpoint URL"
  type        = string
}

# -----------------------------------------------------------------------------
# Feature Configuration
# -----------------------------------------------------------------------------

variable "supported_models" {
  description = "Map of display name to model ID for supported Bedrock models"
  type        = map(string)
  default     = {}
}

variable "reranking_models" {
  description = "Map of display name to model ID for reranking models"
  type        = map(string)
  default     = {}
}

variable "knowledge_base_supported" {
  description = "Whether knowledge base feature is enabled"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Data Processing Configuration (Optional)
# -----------------------------------------------------------------------------

variable "data_bucket_name" {
  description = "Name of the S3 data bucket for document uploads (from data_processing module)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Geo Restrictions (Optional)
# -----------------------------------------------------------------------------

variable "enable_geo_restrictions" {
  description = "Enable CloudFront geo restrictions"
  type        = bool
  default     = false
}

variable "allowed_geo_regions" {
  description = "List of allowed country codes (ISO 3166-1 alpha-2)"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# AWS CLI Profile (for S3 sync)
# -----------------------------------------------------------------------------

variable "aws_profile" {
  description = "AWS CLI profile name for S3 sync commands"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
