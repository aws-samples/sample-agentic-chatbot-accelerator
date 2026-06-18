/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AgentCore Module - Main Resources

Creates:
- DynamoDB tables for agent configuration, tool registry, MCP servers, and summary
- SNS topic for agent tools messaging
- Initial data seeding for tool and MCP server registries
*/

locals {
  # Lowercase prefix for resource naming (matches CDK generatePrefix behavior)
  name_prefix = lower(var.prefix)

  # Agent name format for runtime (underscores, not hyphens)
  agent_name = replace("${local.name_prefix}-default-agent", "-", "_")
}

# Get current AWS account and region
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# NOTE: KMS key is now passed from root module (var.kms_key_arn, var.kms_key_id)
# to avoid circular dependencies with knowledge_base module

# -----------------------------------------------------------------------------
# DynamoDB Tables
# -----------------------------------------------------------------------------

# Agent Runtime Configuration Table
# Stores agent configurations with versioning support
resource "aws_dynamodb_table" "agent_runtime_config" {
  name         = "${local.name_prefix}-agentCoreRuntimeCfgTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "AgentName"
  range_key = "CreatedAt"

  attribute {
    name = "AgentName"
    type = "S"
  }

  attribute {
    name = "CreatedAt"
    type = "N"
  }

  attribute {
    name = "AgentRuntimeVersion"
    type = "S"
  }

  local_secondary_index {
    name            = "byAgentNameAndVersion"
    projection_type = "ALL"
    range_key       = "AgentRuntimeVersion"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-agentCoreRuntimeCfgTable"
  }
}

# Tool Registry Table
# Stores tool specifications available to agents
resource "aws_dynamodb_table" "tool_registry" {
  name         = "${local.name_prefix}-toolRegistryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "ToolName"

  attribute {
    name = "ToolName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-toolRegistryTable"
  }
}

# State Class Registry Table
# Stores predefined state classes for graph pipelines (UI discovery)
resource "aws_dynamodb_table" "state_class_registry" {
  name         = "${local.name_prefix}-stateClassRegistryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "StateClassKey"

  attribute {
    name = "StateClassKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-stateClassRegistryTable"
  }
}

# Deterministic Node Registry Table
# Stores deterministic node function metadata for graph pipelines (UI discovery)
resource "aws_dynamodb_table" "deterministic_node_registry" {
  name         = "${local.name_prefix}-deterministicNodeRegistryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "DeterministicNodeKey"

  attribute {
    name = "DeterministicNodeKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-deterministicNodeRegistryTable"
  }
}

# Structured Output Registry Table
# Stores structured output model metadata for agent pipelines (UI discovery)
resource "aws_dynamodb_table" "structured_output_registry" {
  name         = "${local.name_prefix}-structuredOutputRegistryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "StructuredOutputKey"

  attribute {
    name = "StructuredOutputKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-structuredOutputRegistryTable"
  }
}

# MCP Server Registry Table
# Stores MCP server configurations
resource "aws_dynamodb_table" "mcp_server_registry" {
  name         = "${local.name_prefix}-mcpServerRegistryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "McpServerName"

  attribute {
    name = "McpServerName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-mcpServerRegistryTable"
  }
}

# Agent Summary Table
# Stores data for visual rendering in the UI
resource "aws_dynamodb_table" "agent_summary" {
  name         = "${local.name_prefix}-agentCoreSummaryTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "AgentName"

  attribute {
    name = "AgentName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-agentCoreSummaryTable"
  }
}

# -----------------------------------------------------------------------------
# DynamoDB Seeding - Tool Registry
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "tool_registry" {
  for_each = { for tool in var.tool_registry : tool.name => tool }

  table_name = aws_dynamodb_table.tool_registry.name
  hash_key   = aws_dynamodb_table.tool_registry.hash_key

  item = jsonencode({
    ToolName        = { S = each.value.name }
    ToolDescription = { S = each.value.description }
    InvokesSubAgent = { BOOL = each.value.invokes_sub_agent }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# -----------------------------------------------------------------------------
# DynamoDB Seeding - State Class Registry
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "state_class_registry" {
  for_each = { for sc in var.state_class_registry : sc.key => sc }

  table_name = aws_dynamodb_table.state_class_registry.name
  hash_key   = aws_dynamodb_table.state_class_registry.hash_key

  item = jsonencode({
    StateClassKey = { S = each.value.key }
    Label         = { S = each.value.label }
    Description   = { S = each.value.description }
    Fields        = { L = [for f in each.value.fields : { S = f }] }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# -----------------------------------------------------------------------------
# DynamoDB Seeding - Deterministic Node Registry
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "deterministic_node_registry" {
  for_each = { for dn in var.deterministic_node_registry : dn.key => dn }

  table_name = aws_dynamodb_table.deterministic_node_registry.name
  hash_key   = aws_dynamodb_table.deterministic_node_registry.hash_key

  item = jsonencode({
    DeterministicNodeKey = { S = each.value.key }
    Label                = { S = each.value.label }
    Description          = { S = each.value.description }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# -----------------------------------------------------------------------------
# DynamoDB Seeding - Structured Output Registry
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table_item" "structured_output_registry" {
  for_each = { for so in var.structured_output_registry : so.key => so }

  table_name = aws_dynamodb_table.structured_output_registry.name
  hash_key   = aws_dynamodb_table.structured_output_registry.hash_key

  item = jsonencode({
    StructuredOutputKey = { S = each.value.key }
    Label               = { S = each.value.label }
    Description         = { S = each.value.description }
    Fields              = { L = [for f in each.value.fields : { S = f }] }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# -----------------------------------------------------------------------------
# DynamoDB Seeding - MCP Server Registry
# Computes McpUrl from runtime_id or gateway_id (matches CDK mcp-seeder Lambda)
# -----------------------------------------------------------------------------

locals {
  # Build MCP server items with computed McpUrl (matches CDK format)
  mcp_servers = { for server in var.mcp_server_registry : server.name => {
    name        = server.name
    description = server.description
    qualifier   = coalesce(server.qualifier, "DEFAULT")
    # Compute McpUrl based on whether it's a runtime or gateway
    mcp_url = server.runtime_id != null ? (
      # Runtime-based MCP server URL
      "https://bedrock-agentcore.${data.aws_region.current.id}.amazonaws.com/runtimes/${urlencode("arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:runtime/${server.runtime_id}")}/invocations?qualifier=${coalesce(server.qualifier, "DEFAULT")}"
      ) : (
      # Gateway-based MCP server URL
      "https://${server.gateway_id}.gateway.bedrock-agentcore.${data.aws_region.current.id}.amazonaws.com/mcp"
    )
  } }
}

resource "aws_dynamodb_table_item" "mcp_server_registry" {
  for_each = local.mcp_servers

  table_name = aws_dynamodb_table.mcp_server_registry.name
  hash_key   = aws_dynamodb_table.mcp_server_registry.hash_key

  # Schema matches CDK: McpServerName, Description, McpUrl
  item = jsonencode({
    McpServerName = { S = each.value.name }
    Description   = { S = each.value.description }
    McpUrl        = { S = each.value.mcp_url }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
