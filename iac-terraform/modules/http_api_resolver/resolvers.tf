/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
HTTP API Resolver Module - AppSync Resolvers

Creates:
- Lambda-backed resolvers for general GraphQL operations
- DynamoDB JS resolvers for favorite runtime operations
*/

# -----------------------------------------------------------------------------
# Favorite Runtime JS Resolvers (DynamoDB Direct)
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "update_favorite_runtime" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "updateFavoriteRuntime"
  data_source = aws_appsync_datasource.favorites_dynamodb.name
  kind        = "UNIT"

  code = file("${path.module}/../../../lib/api/functions/resolvers/favorite-runtime-resolvers/update.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

resource "aws_appsync_resolver" "reset_favorite_runtime" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "resetFavoriteRuntime"
  data_source = aws_appsync_datasource.favorites_dynamodb.name
  kind        = "UNIT"

  code = file("${path.module}/../../../lib/api/functions/resolvers/favorite-runtime-resolvers/delete.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

resource "aws_appsync_resolver" "get_favorite_runtime" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getFavoriteRuntime"
  data_source = aws_appsync_datasource.favorites_dynamodb.name
  kind        = "UNIT"

  code = file("${path.module}/../../../lib/api/functions/resolvers/favorite-runtime-resolvers/get.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

# -----------------------------------------------------------------------------
# Lambda-backed Resolvers for General Operations
# Dynamically parses schema.graphql like CDK does
# Operations excluded by other modules are passed via operations_to_exclude
# -----------------------------------------------------------------------------

locals {
  # Read the GraphQL schema file
  schema_content = file(var.graphql_schema_path)

  # Extract the Query type block content
  # Regex matches: type Query { ... } and captures the content between braces
  query_block_match = regex("type Query \\{([^}]+)\\}", local.schema_content)
  query_block       = local.query_block_match[0]

  # Extract the Mutation type block content
  mutation_block_match = regex("type Mutation \\{([^}]+)\\}", local.schema_content)
  mutation_block       = local.mutation_block_match[0]

  # Parse operation names from Query block
  # Regex matches lines like: "  operationName(...): ReturnType" or "  operationName: Type"
  # Captures the operation name (first word after whitespace)
  query_ops_raw    = regexall("\\n\\s+(\\w+)", local.query_block)
  query_operations = [for m in local.query_ops_raw : m[0]]

  # Parse operation names from Mutation block
  mutation_ops_raw    = regexall("\\n\\s+(\\w+)", local.mutation_block)
  mutation_operations = [for m in local.mutation_ops_raw : m[0]]

  # Operations excluded from this module (handled elsewhere)
  # Same exclusions as CDK HttpApiBackend uses
  builtin_exclusions = [
    # WebSocket operations (handled by websocket_backend module)
    "sendQuery",
    "publishResponse",
    # DynamoDB direct resolvers (handled above with JS resolvers)
    "updateFavoriteRuntime",
    "getFavoriteRuntime",
    "resetFavoriteRuntime",
    # IAM-only operations (internal)
    "publishRuntimeUpdate",
  ]

  # Combined exclusions: built-in + module-provided (KB, AgentCore APIs)
  all_exclusions = concat(local.builtin_exclusions, var.operations_to_exclude)

  # Filter to get only operations this module should handle
  filtered_query_operations = [
    for op in local.query_operations : op
    if !contains(local.all_exclusions, op)
  ]

  filtered_mutation_operations = [
    for op in local.mutation_operations : op
    if !contains(local.all_exclusions, op)
  ]
}

# Query resolvers
resource "aws_appsync_resolver" "query_resolvers" {
  for_each = toset(local.filtered_query_operations)

  api_id      = var.appsync_api_id
  type        = "Query"
  field       = each.value
  data_source = aws_appsync_datasource.lambda_resolver.name
  kind        = "UNIT"
}

# Mutation resolvers
resource "aws_appsync_resolver" "mutation_resolvers" {
  for_each = toset(local.filtered_mutation_operations)

  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = each.value
  data_source = aws_appsync_datasource.lambda_resolver.name
  kind        = "UNIT"
}
