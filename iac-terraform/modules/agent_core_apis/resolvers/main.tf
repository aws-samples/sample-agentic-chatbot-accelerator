/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Resolvers Sub-module

Creates:
- AppSync Lambda data source for agent core resolver
- Lambda-backed resolvers for CRUD operations
- JS resolvers for runtime update subscription
*/

locals {
  name_prefix   = lower(var.prefix)
  resolvers_dir = "${path.module}/../../../../lib/api/functions/resolvers"

  # Lambda-backed resolver operations (main agentCoreResolver)
  lambda_operations = [
    { type = "Mutation", field = "createAgentCoreRuntime" },
    { type = "Query", field = "listRuntimeAgents" },
    { type = "Query", field = "getRuntimeConfigurationByVersion" },
    { type = "Query", field = "getRuntimeConfigurationByQualifier" },
    { type = "Query", field = "getDefaultRuntimeConfiguration" },
    { type = "Mutation", field = "tagAgentCoreRuntime" },
    { type = "Query", field = "listAgentVersions" },
    { type = "Query", field = "listAgentEndpoints" },
    { type = "Mutation", field = "deleteAgentRuntime" },
    { type = "Mutation", field = "deleteAgentRuntimeEndpoints" },
  ]

  # Convert to map for for_each
  lambda_operations_map = { for op in local.lambda_operations : op.field => op }
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# AppSync Lambda Data Source for Agent Core Resolver
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "agent_core_resolver" {
  api_id           = var.appsync_api_id
  name             = "${replace(local.name_prefix, "-", "_")}_agentCoreResolverDataSource"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_lambda_datasource.arn

  lambda_config {
    function_arn = var.agent_core_resolver_function_arn
  }
}

# IAM role for AppSync to invoke Lambda
data "aws_iam_policy_document" "appsync_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["appsync.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "appsync_lambda_datasource" {
  name               = "${local.name_prefix}-appsync-agentcore-ds-role"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-agentcore-ds-role"
  })
}

data "aws_iam_policy_document" "appsync_invoke_lambda" {
  statement {
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.agent_core_resolver_function_arn]
  }
}

resource "aws_iam_role_policy" "appsync_invoke_lambda" {
  name   = "${local.name_prefix}-appsync-invoke-agentcore"
  role   = aws_iam_role.appsync_lambda_datasource.id
  policy = data.aws_iam_policy_document.appsync_invoke_lambda.json
}

# -----------------------------------------------------------------------------
# Lambda-backed Resolvers for CRUD Operations
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "lambda_resolvers" {
  for_each = local.lambda_operations_map

  api_id      = var.appsync_api_id
  type        = each.value.type
  field       = each.value.field
  data_source = aws_appsync_datasource.agent_core_resolver.name
  kind        = "UNIT"
}

# -----------------------------------------------------------------------------
# None Data Source for Subscription/Relay Resolvers
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "agent_factory_none" {
  api_id = var.appsync_api_id
  name   = "agentFactory_relay_source"
  type   = "NONE"
}

# -----------------------------------------------------------------------------
# JS Resolvers for Runtime Update Subscription
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "publish_runtime_update" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "publishRuntimeUpdate"
  data_source = aws_appsync_datasource.agent_factory_none.name
  kind        = "UNIT"

  code = file("${local.resolvers_dir}/runtime-update/publish.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

resource "aws_appsync_resolver" "receive_update_notification" {
  api_id      = var.appsync_api_id
  type        = "Subscription"
  field       = "receiveUpdateNotification"
  data_source = aws_appsync_datasource.agent_factory_none.name
  kind        = "UNIT"

  code = file("${local.resolvers_dir}/runtime-update/subscribe.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}
