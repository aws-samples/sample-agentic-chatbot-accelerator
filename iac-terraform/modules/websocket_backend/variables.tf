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

# -----------------------------------------------------------------------------
# Pre-built Lambda Artifacts (S3)
# outgoing-message-handler is built by CodeBuild in the shared module
# -----------------------------------------------------------------------------

variable "outgoing_message_handler_s3_bucket" {
  description = "S3 bucket containing the outgoing-message-handler Lambda zip"
  type        = string
}

variable "outgoing_message_handler_s3_key" {
  description = "S3 key for the outgoing-message-handler Lambda zip"
  type        = string
}

variable "outgoing_message_handler_source_hash" {
  description = "Content hash for change detection"
  type        = string
}
