/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AgentCore Module - Bedrock AgentCore Runtime

Creates (when agent_runtime_config is provided):
- Bedrock AgentCore Memory (optional)
- Bedrock AgentCore Agent Runtime
- DynamoDB items for agent configuration
*/

# -----------------------------------------------------------------------------
# AgentCore Memory (Optional)
# Created only if memory_config is provided in agent_runtime_config
# -----------------------------------------------------------------------------

resource "aws_bedrockagentcore_memory" "default" {
  count = var.agent_runtime_config != null && var.agent_runtime_config.memory_config != null ? 1 : 0

  name                  = replace("${local.name_prefix}-default-memory", "-", "_")
  description           = var.agent_runtime_config.memory_config.description
  event_expiry_duration = var.agent_runtime_config.memory_config.retention_days

  tags = {
    Name  = "${local.name_prefix}-default-memory"
    Owner = "Terraform"
  }
}

# -----------------------------------------------------------------------------
# AgentCore Agent Runtime
# Created only if agent_runtime_config is provided
# -----------------------------------------------------------------------------

resource "aws_bedrockagentcore_agent_runtime" "default" {
  count = var.agent_runtime_config != null ? 1 : 0

  agent_runtime_name = local.agent_name
  description        = var.agent_runtime_config.description
  role_arn           = aws_iam_role.execution.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = local.container_uri
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  environment_variables = {
    accountId          = data.aws_caller_identity.current.account_id
    agentName          = local.agent_name
    createdAt          = local.created_at
    tableName          = aws_dynamodb_table.agent_runtime_config.name
    toolRegistry       = aws_dynamodb_table.tool_registry.name
    mcpServerRegistry  = aws_dynamodb_table.mcp_server_registry.name
    agentToolsTopicArn = aws_sns_topic.agent_tools.arn
    memoryId           = var.agent_runtime_config.memory_config != null ? aws_bedrockagentcore_memory.default[0].id : ""
  }

  dynamic "lifecycle_configuration" {
    for_each = var.agent_runtime_config.lifecycle_config != null ? [1] : []
    content {
      idle_runtime_session_timeout = var.agent_runtime_config.lifecycle_config.idle_runtime_session_timeout_minutes * 60
      max_lifetime                 = var.agent_runtime_config.lifecycle_config.max_lifetime_hours * 3600
    }
  }

  tags = {
    Name        = local.agent_name
    Owner       = "Terraform"
    Stack       = var.stack_tag
    Environment = var.environment_tag
  }

  depends_on = [
    aws_iam_role_policy.execution,
    aws_bedrockagentcore_memory.default
  ]
}

# -----------------------------------------------------------------------------
# Compute stable created_at timestamp based on config hash
# This ensures consistent values across Terraform runs
# -----------------------------------------------------------------------------

locals {
  # Enrich tool parameters with kb_id for retrieve_from_kb tools (matches CDK behavior)
  # This injects the knowledge_base_id into tool parameters at deploy time
  enriched_tool_parameters = var.agent_runtime_config != null ? {
    for tool_name, params in var.agent_runtime_config.tool_parameters :
    tool_name => (
      # If tool starts with "retrieve_from_kb" and we have a knowledge_base_id, inject kb_id
      startswith(tool_name, "retrieve_from_kb") && var.knowledge_base_id != null
      ? merge(params, { kb_id = var.knowledge_base_id })
      : params
    )
  } : {}

  # Base config for hashing (without kb_id to maintain stable hashes)
  # Note: Field names must be camelCase to match the AgentConfiguration Pydantic model
  base_config = var.agent_runtime_config != null ? {
    modelInferenceParameters = {
      modelId = var.agent_runtime_config.model_inference_parameters.model_id
      parameters = {
        maxTokens     = var.agent_runtime_config.model_inference_parameters.parameters.max_tokens
        temperature   = var.agent_runtime_config.model_inference_parameters.parameters.temperature
        stopSequences = var.agent_runtime_config.model_inference_parameters.parameters.stop_sequences
      }
    }
    instructions        = var.agent_runtime_config.instructions
    tools               = var.agent_runtime_config.tools
    toolParameters      = var.agent_runtime_config.tool_parameters # Use original for hashing
    mcpServers          = var.agent_runtime_config.mcp_servers
    conversationManager = var.agent_runtime_config.conversation_manager
  } : null

  # Config with enriched tool parameters (includes kb_id) - this is what gets stored in DynamoDB
  enriched_config = var.agent_runtime_config != null ? {
    modelInferenceParameters = local.base_config.modelInferenceParameters
    instructions             = local.base_config.instructions
    tools                    = local.base_config.tools
    toolParameters           = local.enriched_tool_parameters # Use enriched params
    mcpServers               = local.base_config.mcpServers
    conversationManager      = local.base_config.conversationManager
  } : null

  # Serialize for hashing (use base config without kb_id for stable hashes)
  config_json = var.agent_runtime_config != null ? jsonencode(local.base_config) : ""

  # Serialize enriched config for storage in DynamoDB
  enriched_config_json = var.agent_runtime_config != null ? jsonencode(local.enriched_config) : ""

  # Generate a stable timestamp from config hash
  config_hash = var.agent_runtime_config != null ? sha256(local.config_json) : ""
  # Use first 8 hex chars converted to decimal as created_at
  created_at = var.agent_runtime_config != null ? parseint(substr(local.config_hash, 0, 8), 16) : 0
}

# -----------------------------------------------------------------------------
# Seed Agent Runtime Configuration to DynamoDB
# This stores the full agent configuration for runtime access
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "agent_runtime_config" {
  count = var.agent_runtime_config != null ? 1 : 0

  table_name = aws_dynamodb_table.agent_runtime_config.name
  hash_key   = aws_dynamodb_table.agent_runtime_config.hash_key
  range_key  = aws_dynamodb_table.agent_runtime_config.range_key

  # Use enriched_config_json which includes kb_id injected into retrieve_from_kb tool parameters
  item = jsonencode({
    AgentName           = { S = local.agent_name }
    CreatedAt           = { N = tostring(local.created_at) }
    AgentRuntimeArn     = { S = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_arn }
    AgentRuntimeId      = { S = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_id }
    AgentRuntimeVersion = { S = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_version }
    ConfigurationValue  = { S = local.enriched_config_json }
  })

  depends_on = [aws_bedrockagentcore_agent_runtime.default]
}

# -----------------------------------------------------------------------------
# Seed Agent Summary to DynamoDB
# This stores summary data for UI rendering
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "agent_summary" {
  count = var.agent_runtime_config != null ? 1 : 0

  table_name = aws_dynamodb_table.agent_summary.name
  hash_key   = aws_dynamodb_table.agent_summary.hash_key

  item = jsonencode({
    AgentName       = { S = local.agent_name }
    AgentRuntimeArn = { S = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_arn }
    AgentRuntimeId  = { S = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_id }
    Description     = { S = coalesce(var.agent_runtime_config.description, "") }
    CreatedAt       = { N = tostring(local.created_at) }
    Owner           = { S = "Terraform" }
    # NumberOfVersions and QualifierToVersion are required by the resolver
    # to map qualifier names (like "DEFAULT") to runtime versions
    NumberOfVersions = { N = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_version }
    QualifierToVersion = {
      M = {
        DEFAULT = { N = aws_bedrockagentcore_agent_runtime.default[0].agent_runtime_version }
      }
    }
  })

  depends_on = [aws_bedrockagentcore_agent_runtime.default]
}
