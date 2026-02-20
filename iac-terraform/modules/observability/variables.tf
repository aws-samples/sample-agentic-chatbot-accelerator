/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Observability Module - Input Variables

Creates X-Ray Transaction Search and CloudWatch Dashboard for AgentCore.
Equivalent to: lib/observability/index.ts
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'aca-dev')"
  type        = string
}

# -----------------------------------------------------------------------------
# Transaction Search Configuration
# -----------------------------------------------------------------------------

variable "enable_transaction_search" {
  description = "Enable X-Ray Transaction Search for distributed tracing"
  type        = bool
  default     = true
}

variable "indexing_percentage" {
  description = "Percentage of traces indexed from CloudWatch Logs to X-Ray (1-100)"
  type        = number
  default     = 10

  validation {
    condition     = var.indexing_percentage >= 1 && var.indexing_percentage <= 100
    error_message = "Indexing percentage must be between 1 and 100."
  }
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
