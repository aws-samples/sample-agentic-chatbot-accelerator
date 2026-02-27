/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Parent Module

Wires together:
- lambdas/ sub-module (15 Lambda functions)
- state_machines/ sub-module (3 Step Functions)
- resolvers/ sub-module (AppSync resolvers)

Also handles:
- Adding State Machine ARN environment variables to main resolver Lambda
- Granting Step Function execution permissions
*/

locals {
  name_prefix = lower(var.prefix)

  # Pre-computed state machine ARNs to break circular dependency
  # Lambda needs these ARNs before state machines are created
  # State machine names are predictable based on prefix
  create_runtime_state_machine_arn   = "arn:aws:states:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name_prefix}-createAgentCoreRuntime"
  delete_runtime_state_machine_arn   = "arn:aws:states:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name_prefix}-deleteAgentCoreRuntime"
  delete_endpoints_state_machine_arn = "arn:aws:states:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name_prefix}-deleteAgentCoreEndpoint"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Lambdas Sub-module
# Creates all Lambda functions for agent core operations
# -----------------------------------------------------------------------------

module "lambdas" {
  source = "./lambdas"

  prefix = var.prefix

  # Layers & runtime
  powertools_layer_arn = var.powertools_layer_arn
  boto3_layer_arn      = var.boto3_layer_arn
  genai_core_layer_arn = var.genai_core_layer_arn
  python_runtime       = var.python_runtime
  lambda_architecture  = var.lambda_architecture

  # Container
  container_uri       = var.container_uri
  swarm_container_uri = var.swarm_container_uri

  # DynamoDB tables
  agent_core_runtime_table_name  = var.agent_core_runtime_table_name
  agent_core_runtime_table_arn   = var.agent_core_runtime_table_arn
  agent_core_summary_table_name  = var.agent_core_summary_table_name
  agent_core_summary_table_arn   = var.agent_core_summary_table_arn
  tool_registry_table_name       = var.tool_registry_table_name
  tool_registry_table_arn        = var.tool_registry_table_arn
  mcp_server_registry_table_name = var.mcp_server_registry_table_name
  mcp_server_registry_table_arn  = var.mcp_server_registry_table_arn

  # IAM
  agent_core_execution_role_arn = var.agent_core_execution_role_arn

  # SNS
  agent_tools_topic_arn = var.agent_tools_topic_arn

  # AppSync
  graphql_url    = var.graphql_url
  appsync_api_id = var.appsync_api_id

  # Tags
  stack_tag       = var.stack_tag
  environment_tag = var.environment_tag

  # KMS
  kms_key_arn = var.kms_key_arn
  tags        = var.tags

  # State machine ARNs (pre-computed to break circular dependency)
  create_runtime_state_machine_arn   = local.create_runtime_state_machine_arn
  delete_runtime_state_machine_arn   = local.delete_runtime_state_machine_arn
  delete_endpoints_state_machine_arn = local.delete_endpoints_state_machine_arn

  # Pre-built Lambda artifacts (S3)
  notify_runtime_update_s3_bucket   = var.notify_runtime_update_s3_bucket
  notify_runtime_update_s3_key      = var.notify_runtime_update_s3_key
  notify_runtime_update_source_hash = var.notify_runtime_update_source_hash
}

# -----------------------------------------------------------------------------
# State Machines Sub-module
# Creates 3 Step Functions for runtime lifecycle management
# -----------------------------------------------------------------------------

module "state_machines" {
  source = "./state_machines"

  prefix = var.prefix

  # Lambda ARNs from lambdas sub-module
  delete_endpoint_function_arn        = module.lambdas.delete_endpoint_function_arn
  check_delete_endpoint_function_arn  = module.lambdas.check_delete_endpoint_function_arn
  list_endpoints_function_arn         = module.lambdas.list_endpoints_function_arn
  delete_runtime_function_arn         = module.lambdas.delete_runtime_function_arn
  check_delete_runtime_function_arn   = module.lambdas.check_delete_runtime_function_arn
  check_exist_memory_function_arn     = module.lambdas.check_exist_memory_function_arn
  delete_memory_function_arn          = module.lambdas.delete_memory_function_arn
  check_delete_memory_function_arn    = module.lambdas.check_delete_memory_function_arn
  create_memory_function_arn          = module.lambdas.create_memory_function_arn
  check_create_memory_function_arn    = module.lambdas.check_create_memory_function_arn
  create_runtime_version_function_arn = module.lambdas.create_runtime_version_function_arn
  check_create_runtime_function_arn   = module.lambdas.check_create_runtime_function_arn
  remove_references_function_arn      = module.lambdas.remove_references_function_arn
  notify_runtime_update_function_arn  = module.lambdas.notify_runtime_update_function_arn

  # DynamoDB tables
  agent_core_summary_table_arn = var.agent_core_summary_table_arn
  agent_core_runtime_table_arn = var.agent_core_runtime_table_arn

  # KMS
  kms_key_arn = var.kms_key_arn
  tags        = var.tags

  depends_on = [module.lambdas]
}

# -----------------------------------------------------------------------------
# Resolvers Sub-module
# Creates AppSync resolvers and data sources
# -----------------------------------------------------------------------------

module "resolvers" {
  source = "./resolvers"

  prefix = var.prefix

  # AppSync
  appsync_api_id = var.appsync_api_id

  # Lambda
  agent_core_resolver_function_arn = module.lambdas.agent_core_resolver_function_arn

  # Tags
  tags = var.tags

  depends_on = [module.lambdas]
}


# Grant Step Function execution permissions to main resolver Lambda
resource "aws_iam_role_policy" "agent_core_resolver_sfn" {
  name = "${local.name_prefix}-agentCoreResolver-sfn"
  role = module.lambdas.agent_core_resolver_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StartStepFunctionExecutions"
        Effect = "Allow"
        Action = [
          "states:StartExecution"
        ]
        Resource = [
          module.state_machines.delete_endpoints_state_machine_arn,
          module.state_machines.delete_runtime_state_machine_arn,
          module.state_machines.create_runtime_state_machine_arn,
        ]
      }
    ]
  })
}
