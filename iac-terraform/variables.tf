/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

variable "prefix" {
  description = "Prefix string used for naming AWS resources. Equivalent to SystemConfig.prefix in CDK."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*$", var.prefix))
    error_message = "Prefix must start with a letter and contain only alphanumeric characters and hyphens."
  }
}

variable "aws_region" {
  description = "AWS region to deploy resources into."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS profile to use for authentication. Leave null/empty to use default credentials or environment variables."
  type        = string
  default     = null
}

variable "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64). Default is arm64 for better price/performance."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.lambda_architecture)
    error_message = "Lambda architecture must be either 'x86_64' or 'arm64'."
  }
}

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod). Used to isolate Bedrock AgentCore resources (Memory, Runtime) between deployments in the same AWS account."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Agent Core Configuration
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
}

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

variable "ecr_image_tag" {
  description = "Docker image tag for the agent runtime container."
  type        = string
  default     = "latest"
}

variable "ecr_image_uri" {
  description = "Full ECR image URI if using an existing image. If not provided, a new ECR repository will be created."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# User Interface Configuration
# -----------------------------------------------------------------------------

variable "supported_models" {
  description = "Map of display name to model ID for supported Bedrock models. Key = display name, Value = model ID."
  type        = map(string)
  default     = {}
}

variable "reranking_models" {
  description = "Map of display name to model ID for reranking models. Key = display name, Value = model ID."
  type        = map(string)
  default     = {}
}

variable "enable_geo_restrictions" {
  description = "Enable CloudFront geo restrictions."
  type        = bool
  default     = false
}

variable "allowed_geo_regions" {
  description = "List of allowed country codes (ISO 3166-1 alpha-2) when geo restrictions are enabled."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Data Processing Configuration (Optional)
# -----------------------------------------------------------------------------

variable "data_processing" {
  description = "Optional data processing configuration for document ingestion pipeline. Set to null to disable the module."
  type = object({
    input_prefix       = optional(string, "input")
    data_source_prefix = optional(string, "data-source")
    processing_prefix  = optional(string, "processing")
    staging_midfix     = optional(string, "staging")
    transcribe_midfix  = optional(string, "transcribe")
    language_code      = optional(string, "auto")
  })
  default = null
}

# -----------------------------------------------------------------------------
# Knowledge Base Configuration (Optional)
# Requires data_processing to be enabled
# -----------------------------------------------------------------------------

variable "knowledge_base_id" {
  description = "Knowledge Base ID to inject into retrieve_from_kb tool parameters. Set this after the first deploy using the output from module.knowledge_base.knowledge_base_id."
  type        = string
  default     = null
}

variable "knowledge_base" {
  description = "Optional Knowledge Base configuration using Bedrock with OpenSearch Serverless. Requires data_processing to be enabled."
  type = object({
    # Embedding model configuration
    embedding_model_id = optional(string, "amazon.titan-embed-text-v2:0")
    vector_dimension   = optional(number, 1024)

    # Data source configuration
    data_source_prefix = optional(string, "data-source")
    description        = optional(string, "Knowledge Base for searching helpful information.")

    # Chunking strategy: FIXED_SIZE, HIERARCHICAL, SEMANTIC, or NONE
    chunking_strategy = optional(string, "FIXED_SIZE")

    # Fixed-size chunking configuration (used when chunking_strategy = "FIXED_SIZE")
    fixed_chunking_config = optional(object({
      max_tokens         = number
      overlap_percentage = number
    }), { max_tokens = 300, overlap_percentage = 20 })

    # Hierarchical chunking configuration (used when chunking_strategy = "HIERARCHICAL")
    hierarchical_chunking_config = optional(object({
      overlap_tokens        = number
      max_parent_token_size = number
      max_child_token_size  = number
    }))

    # Semantic chunking configuration (used when chunking_strategy = "SEMANTIC")
    semantic_chunking_config = optional(object({
      buffer_size                     = number
      breakpoint_percentile_threshold = number
      max_tokens                      = number
    }))
  })
  default = null
}

# -----------------------------------------------------------------------------
# Observability Configuration (Optional)
# Enables X-Ray Transaction Search and CloudWatch Dashboard for AgentCore
# -----------------------------------------------------------------------------

variable "observability" {
  description = "Optional observability configuration for AgentCore agents. Enables X-Ray Transaction Search and CloudWatch Dashboard."
  type = object({
    enable_transaction_search = optional(bool, true)
    indexing_percentage       = optional(number, 10)
  })
  default = null
}
