/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# Required Variables
# -----------------------------------------------------------------------------

variable "prefix" {
  description = "Prefix string used for naming AWS resources."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*$", var.prefix))
    error_message = "Prefix must start with a letter and contain only alphanumeric characters and hyphens."
  }
}

variable "shared" {
  description = "Shared module outputs containing layer ARNs and Lambda configuration."
  type = object({
    powertools_layer_arn          = string
    boto3_layer_arn               = string
    genai_core_layer_arn          = string
    python_runtime                = string
    lambda_architecture           = string
    default_environment_variables = map(string)
  })
}

# -----------------------------------------------------------------------------
# Tool Registry Configuration
# -----------------------------------------------------------------------------

variable "tool_registry" {
  description = "List of tools available to agents for task execution."
  type = list(object({
    name              = string
    description       = string
    invokes_sub_agent = bool
  }))
  default = []
}

# -----------------------------------------------------------------------------
# MCP Server Registry Configuration
# -----------------------------------------------------------------------------

variable "mcp_server_registry" {
  description = "List of MCP server configurations for external capability providers."
  type = list(object({
    name        = string
    description = string
    runtime_id  = optional(string)
    gateway_id  = optional(string)
    qualifier   = optional(string)
  }))
  default = []

  validation {
    condition = alltrue([
      for server in var.mcp_server_registry :
      (server.runtime_id != null && server.gateway_id == null) ||
      (server.runtime_id == null && server.gateway_id != null)
    ])
    error_message = "Each MCP server must have exactly one of runtime_id or gateway_id, not both."
  }
}

# -----------------------------------------------------------------------------
# Agent Runtime Configuration (Optional)
# -----------------------------------------------------------------------------

variable "agent_runtime_config" {
  description = "Optional configuration for the default agent runtime."
  type = object({
    model_inference_parameters = object({
      model_id = string
      parameters = object({
        temperature    = number
        max_tokens     = number
        stop_sequences = optional(list(string))
      })
    })
    instructions         = string
    tools                = list(string)
    tool_parameters      = map(map(any))
    mcp_servers          = list(string)
    conversation_manager = string
    description          = optional(string)
    memory_config = optional(object({
      retention_days = number
      description    = optional(string)
    }))
    lifecycle_config = optional(object({
      idle_runtime_session_timeout_minutes = number
      max_lifetime_hours                   = number
    }))
  })
  default = null
}

# -----------------------------------------------------------------------------
# ECR Configuration
# -----------------------------------------------------------------------------

variable "ecr_image_tag" {
  description = "Docker image tag for the agent runtime container. Must be pushed to ECR before deployment."
  type        = string
  default     = "latest"
}

variable "ecr_image_uri" {
  description = "Full ECR image URI if using an existing image. If not provided, a new ECR repository will be created."
  type        = string
  default     = null
}

variable "swarm_ecr_image_uri" {
  description = "Full ECR image URI for the swarm agent runtime container. If not provided, a new ECR repository will be created."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Tagging Configuration
# Used for IAM policy scoping
# -----------------------------------------------------------------------------

variable "stack_tag" {
  description = "Stack tag value for IAM policy scoping (e.g., 'aca')"
  type        = string
}

variable "environment_tag" {
  description = "Environment tag value for IAM policy scoping (e.g., 'dev', 'prod')"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# KMS Configuration
# -----------------------------------------------------------------------------

variable "kms_key_arn" {
  description = "ARN of the KMS key for encrypting resources (DynamoDB, SNS, CloudWatch Logs). Passed from root module to avoid circular dependencies."
  type        = string
}

variable "kms_key_id" {
  description = "ID of the KMS key for encrypting resources. Passed from root module to avoid circular dependencies."
  type        = string
}

# -----------------------------------------------------------------------------
# Knowledge Base Integration
# -----------------------------------------------------------------------------

variable "knowledge_base_id" {
  description = "Optional Knowledge Base ID to inject into retrieve_from_kb tool parameters. When provided, tools starting with 'retrieve_from_kb' will have kb_id added to their parameters."
  type        = string
  default     = null
}
