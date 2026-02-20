/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Resolvers Sub-module - Input Variables
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

# -----------------------------------------------------------------------------
# Lambda Function ARNs
# -----------------------------------------------------------------------------

variable "agent_core_resolver_function_arn" {
  description = "ARN of the main agent core resolver Lambda function"
  type        = string
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
