/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - Lambdas Sub-module - Step Function Helper Lambdas

Creates 13 Python Lambda functions used by Step Functions:
- Endpoint deletion: delete, check
- Runtime deletion: list endpoints, delete, check
- Memory operations: check exist, delete, check delete, create, check create
- Runtime creation: create, check
- Cleanup: remove runtime references
*/

# -----------------------------------------------------------------------------
# Lambda Function Configuration Map
# Data-driven approach to reduce repetition
# -----------------------------------------------------------------------------

locals {
  # Base environment variables for all Step Function Lambdas
  base_env_vars = {
    POWERTOOLS_LOG_LEVEL = "INFO"
    REGION_NAME          = data.aws_region.current.id
  }

  # Lambda configuration map - all Step Function helper functions
  step_function_lambdas = {
    # Endpoint deletion
    delete_endpoint = {
      name        = "startRuntimeEndpointDeletion"
      asset       = "delete-agent-runtime-endpoint"
      description = "Initiates deletion of Bedrock AgentCore runtime endpoint"
      permissions = ["bedrock-agentcore:DeleteAgentRuntimeEndpoint"]
      resource    = "runtime/*"
      extra_envs  = {}
    }
    check_delete_endpoint = {
      name        = "checkOnRuntimeEndpointDeletion"
      asset       = "check-on-delete-endpoint"
      description = "Checks status of runtime endpoint deletion"
      permissions = ["bedrock-agentcore:GetAgentRuntimeEndpoint"]
      resource    = "runtime/*"
      extra_envs  = {}
    }

    # Runtime operations
    list_endpoints = {
      name        = "listRuntimeEndpoints"
      asset       = "list-agent-runtime-endpoints"
      description = "Lists all endpoints for a runtime"
      permissions = ["bedrock-agentcore:ListAgentRuntimeEndpoints"]
      resource    = "runtime/*"
      extra_envs  = {}
    }
    delete_runtime = {
      name        = "startDeleteRuntime"
      asset       = "delete-agent-runtime"
      description = "Initiates deletion of Bedrock AgentCore runtime"
      permissions = ["bedrock-agentcore:DeleteAgentRuntime"]
      resource    = "runtime/*"
      extra_envs  = {}
    }
    check_delete_runtime = {
      name        = "checkOnDeleteRuntime"
      asset       = "check-on-delete-runtime"
      description = "Checks status of runtime deletion"
      permissions = ["bedrock-agentcore:GetAgentRuntime"]
      resource    = "runtime/*"
      extra_envs  = {}
    }

    # Memory operations
    check_exist_memory = {
      name        = "checkOnExistMemory"
      asset       = "check-on-exist-memory"
      description = "Checks if memory exists for a runtime"
      permissions = ["bedrock-agentcore:ListMemories", "bedrock-agentcore:GetMemory", "bedrock-agentcore:ListTagsForResource"]
      resource    = "memory/*"
      extra_envs = {
        ENVIRONMENT_TAG = var.environment_tag
        STACK_TAG       = var.stack_tag
      }
    }
    delete_memory = {
      name        = "startDeleteMemory"
      asset       = "delete-memory"
      description = "Initiates deletion of memory"
      permissions = ["bedrock-agentcore:DeleteMemory"]
      resource    = "memory/*"
      extra_envs  = {}
    }
    check_delete_memory = {
      name        = "checkOnDeleteMemory"
      asset       = "check-on-delete-memory"
      description = "Checks status of memory deletion"
      permissions = ["bedrock-agentcore:GetMemory"]
      resource    = "memory/*"
      extra_envs  = {}
    }
    create_memory = {
      name        = "startMemoryCreation"
      asset       = "create-memory"
      description = "Creates memory for a runtime"
      permissions = ["bedrock-agentcore:CreateMemory", "bedrock-agentcore:TagResource"]
      resource    = "memory/*"
      extra_envs = {
        ENVIRONMENT_TAG = var.environment_tag
        STACK_TAG       = var.stack_tag
      }
    }
    check_create_memory = {
      name        = "checkOnCreateMemory"
      asset       = "check-on-create-memory"
      description = "Checks status of memory creation"
      permissions = ["bedrock-agentcore:GetMemory"]
      resource    = "memory/*"
      extra_envs  = {}
    }

    # Runtime creation
    check_create_runtime = {
      name        = "checkOnRuntimeCreation"
      asset       = "check-on-create-runtime"
      description = "Checks status of runtime creation"
      permissions = ["bedrock-agentcore:GetAgentRuntime"]
      resource    = "runtime/*"
      extra_envs  = {}
    }

    # Cleanup
    remove_references = {
      name        = "removeRuntimeReferences"
      asset       = "delete-agent-runtime-references"
      description = "Removes runtime version references from DynamoDB"
      permissions = []
      resource    = ""
      extra_envs = {
        VERSIONS_TABLE_NAME = var.agent_core_runtime_table_name
      }
    }
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Groups for Step Function Lambdas
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "step_function_lambdas" {
  for_each = local.step_function_lambdas

  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-${each.value.name}"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-${each.value.name}-logs"
  })
}

# -----------------------------------------------------------------------------
# Archive Files for Step Function Lambdas
# -----------------------------------------------------------------------------

data "archive_file" "step_function_lambdas" {
  for_each = local.step_function_lambdas

  type        = "zip"
  source_dir  = "${local.functions_dir}/${each.value.asset}"
  output_path = "${path.module}/../../../../iac-terraform/build/${each.value.asset}.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache", "genai_core"]
}

# -----------------------------------------------------------------------------
# Lambda Functions for Step Functions
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "step_function_lambdas" {
  for_each = local.step_function_lambdas

  # checkov:skip=CKV_AWS_116:DLQ handled by Step Functions retry
  # checkov:skip=CKV_AWS_117:VPC not required for these functions
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-${each.value.name}"
  description   = each.value.description

  filename         = data.archive_file.step_function_lambdas[each.key].output_path
  source_code_hash = data.archive_file.step_function_lambdas[each.key].output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 60
  memory_size      = 128

  role = aws_iam_role.step_function_lambdas[each.key].arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = merge(local.base_env_vars, each.value.extra_envs, {
      POWERTOOLS_SERVICE_NAME = each.value.name
    })
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.step_function_lambdas]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-${each.value.name}"
  })
}

# -----------------------------------------------------------------------------
# IAM Roles for Step Function Lambdas
# -----------------------------------------------------------------------------

resource "aws_iam_role" "step_function_lambdas" {
  for_each = local.step_function_lambdas

  name               = "${local.name_prefix}-${each.value.name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-${each.value.name}-role"
  })
}

resource "aws_iam_role_policy_attachment" "step_function_lambdas_basic" {
  for_each = local.step_function_lambdas

  role       = aws_iam_role.step_function_lambdas[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "step_function_lambdas_xray" {
  for_each = local.step_function_lambdas

  role       = aws_iam_role.step_function_lambdas[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Bedrock AgentCore permissions (only for functions that need them)
resource "aws_iam_role_policy" "step_function_lambdas_bedrock" {
  for_each = {
    for k, v in local.step_function_lambdas : k => v
    if length(v.permissions) > 0
  }

  name = "${local.name_prefix}-${each.value.name}-bedrock"
  role = aws_iam_role.step_function_lambdas[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BedrockAgentCoreAccess"
        Effect   = "Allow"
        Action   = each.value.permissions
        Resource = "arn:aws:bedrock-agentcore:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:${each.value.resource}"
      }
    ]
  })
}

# DynamoDB access for remove_references function
resource "aws_iam_role_policy" "remove_references_dynamodb" {
  name = "${local.name_prefix}-removeRuntimeReferences-dynamodb"
  role = aws_iam_role.step_function_lambdas["remove_references"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RuntimeTableAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          var.agent_core_runtime_table_arn,
          "${var.agent_core_runtime_table_arn}/index/*"
        ]
      },
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Create Runtime Version Lambda (Special case - needs more permissions)
# This one needs full AgentCore access + PassRole + extra env vars
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "create_runtime_version" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-startRuntimeCreation"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-startRuntimeCreation-logs"
  })
}

data "archive_file" "create_runtime_version" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/create-runtime-version"
  output_path = "${path.module}/../../../../iac-terraform/build/create-runtime-version.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache", "genai_core"]
}

resource "aws_lambda_function" "create_runtime_version" {
  # checkov:skip=CKV_AWS_116:DLQ handled by Step Functions retry
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-startRuntimeCreation"
  description   = "Creates or updates Bedrock AgentCore runtime"

  filename         = data.archive_file.create_runtime_version.output_path
  source_code_hash = data.archive_file.create_runtime_version.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 60
  memory_size      = 128

  role = aws_iam_role.create_runtime_version.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      POWERTOOLS_SERVICE_NAME     = "startRuntimeCreation"
      POWERTOOLS_LOG_LEVEL        = "INFO"
      REGION_NAME                 = data.aws_region.current.id
      CONTAINER_URI               = var.container_uri
      SWARM_CONTAINER_URI         = var.swarm_container_uri
      AGENT_CORE_RUNTIME_ROLE_ARN = var.agent_core_execution_role_arn
      AGENT_CORE_RUNTIME_TABLE    = var.agent_core_runtime_table_name
      TOOL_REGISTRY_TABLE         = var.tool_registry_table_name
      MCP_SERVER_REGISTRY_TABLE   = var.mcp_server_registry_table_name
      ACCOUNT_ID                  = data.aws_caller_identity.current.account_id
      ENVIRONMENT_TAG             = var.environment_tag
      STACK_TAG                   = var.stack_tag
      AGENT_TOOLS_TOPIC_ARN       = var.agent_tools_topic_arn
      AGENTS_TABLE_NAME           = var.agent_core_runtime_table_name
      AGENTS_SUMMARY_TABLE_NAME   = var.agent_core_summary_table_name
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.create_runtime_version]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-startRuntimeCreation"
  })
}

resource "aws_iam_role" "create_runtime_version" {
  name               = "${local.name_prefix}-startRuntimeCreation-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-startRuntimeCreation-role"
  })
}

resource "aws_iam_role_policy_attachment" "create_runtime_version_basic" {
  role       = aws_iam_role.create_runtime_version.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "create_runtime_version_xray" {
  role       = aws_iam_role.create_runtime_version.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Full AgentCore access for create runtime
resource "aws_iam_role_policy_attachment" "create_runtime_version_bedrock" {
  role       = aws_iam_role.create_runtime_version.name
  policy_arn = "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess"
}

# PassRole for create runtime
resource "aws_iam_role_policy" "create_runtime_version_passrole" {
  name = "${local.name_prefix}-startRuntimeCreation-passrole"
  role = aws_iam_role.create_runtime_version.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BedrockAgentCorePassRoleAccess"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = var.agent_core_execution_role_arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "bedrock-agentcore.amazonaws.com"
          }
        }
      }
    ]
  })
}
