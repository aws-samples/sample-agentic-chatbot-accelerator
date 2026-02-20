/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
WebSocket Backend Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

# -----------------------------------------------------------------------------
# AppSync Configuration
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
