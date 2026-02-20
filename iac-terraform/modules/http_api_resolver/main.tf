/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
HTTP API Resolver Module - Lambda Function and AppSync Integration

Creates:
- Lambda function for GraphQL HTTP API resolution
- AppSync Lambda data source
- AppSync DynamoDB data source for favorites
- IAM roles and permissions
*/

locals {
  name_prefix         = lower(var.prefix)
  lambda_function_dir = "${path.module}/../../../lib/api/functions/http-api-handler"
  resolvers_dir       = "${path.module}/../../../lib/api/functions/resolvers"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "http_resolver" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 7 days for Lambda logs is acceptable
  name              = "/aws/lambda/${local.name_prefix}-httpApiResolver"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-httpApiResolver-logs"
  })
}

# -----------------------------------------------------------------------------
# Lambda Function
# -----------------------------------------------------------------------------

data "archive_file" "http_resolver" {
  type        = "zip"
  source_dir  = local.lambda_function_dir
  output_path = "${path.module}/../../../iac-terraform/build/http-api-handler.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

resource "aws_lambda_function" "http_resolver" {
  # checkov:skip=CKV_AWS_116:DLQ not needed for synchronous API resolver
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-httpApiResolver"
  description   = "HTTP API resolver for GraphQL operations"

  filename         = data.archive_file.http_resolver.output_path
  source_code_hash = data.archive_file.http_resolver.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_size

  role = aws_iam_role.http_resolver.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      POWERTOOLS_SERVICE_NAME        = "http-api-resolver"
      POWERTOOLS_LOG_LEVEL           = "INFO"
      SESSIONS_TABLE_NAME            = var.sessions_table_name
      SESSIONS_BY_USER_ID_INDEX_NAME = var.sessions_by_user_index
      TOOL_REGISTRY_TABLE            = var.tool_registry_table_name
      MCP_SERVER_REGISTRY_TABLE      = var.mcp_server_registry_table_name
      REGION_NAME                    = data.aws_region.current.id
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.http_resolver]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-httpApiResolver"
  })
}

# -----------------------------------------------------------------------------
# IAM Role for Lambda
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "http_resolver" {
  name               = "${local.name_prefix}-httpApiResolver-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-httpApiResolver-role"
  })
}

# Basic Lambda execution policy (logs, X-Ray)
resource "aws_iam_role_policy_attachment" "http_resolver_basic" {
  role       = aws_iam_role.http_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "http_resolver_xray" {
  role       = aws_iam_role.http_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# DynamoDB access policy
data "aws_iam_policy_document" "http_resolver_dynamodb" {
  statement {
    sid    = "SessionsTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ]
    resources = [
      var.sessions_table_arn,
      "${var.sessions_table_arn}/index/*"
    ]
  }

  statement {
    sid    = "FavoriteRuntimeTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem"
    ]
    resources = [var.favorite_runtime_table_arn]
  }

  statement {
    sid    = "RegistryTablesReadAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Scan"
    ]
    resources = [
      var.tool_registry_table_arn,
      var.mcp_server_registry_table_arn
    ]
  }

  statement {
    sid    = "KMSAccess"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "http_resolver_dynamodb" {
  name   = "${local.name_prefix}-httpApiResolver-dynamodb"
  role   = aws_iam_role.http_resolver.id
  policy = data.aws_iam_policy_document.http_resolver_dynamodb.json
}

# -----------------------------------------------------------------------------
# AppSync Lambda Data Source
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "lambda_resolver" {
  api_id           = var.appsync_api_id
  name             = "proxyResolverFunction"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_lambda_datasource.arn

  lambda_config {
    function_arn = aws_lambda_function.http_resolver.arn
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
  name               = "${local.name_prefix}-appsync-lambda-ds-role"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-lambda-ds-role"
  })
}

data "aws_iam_policy_document" "appsync_invoke_lambda" {
  statement {
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.http_resolver.arn]
  }
}

resource "aws_iam_role_policy" "appsync_invoke_lambda" {
  name   = "${local.name_prefix}-appsync-invoke-lambda"
  role   = aws_iam_role.appsync_lambda_datasource.id
  policy = data.aws_iam_policy_document.appsync_invoke_lambda.json
}

# -----------------------------------------------------------------------------
# AppSync DynamoDB Data Source for Favorites
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "favorites_dynamodb" {
  api_id           = var.appsync_api_id
  name             = "FavoriteCfgDataSource"
  type             = "AMAZON_DYNAMODB"
  service_role_arn = aws_iam_role.appsync_dynamodb_datasource.arn

  dynamodb_config {
    table_name = var.favorite_runtime_table_name
    region     = data.aws_region.current.id
  }
}

# IAM role for AppSync to access DynamoDB
resource "aws_iam_role" "appsync_dynamodb_datasource" {
  name               = "${local.name_prefix}-appsync-dynamodb-ds-role"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-dynamodb-ds-role"
  })
}

data "aws_iam_policy_document" "appsync_dynamodb_access" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem"
    ]
    resources = [var.favorite_runtime_table_arn]
  }

  statement {
    sid    = "KMSAccess"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "appsync_dynamodb_access" {
  name   = "${local.name_prefix}-appsync-dynamodb-access"
  role   = aws_iam_role.appsync_dynamodb_datasource.id
  policy = data.aws_iam_policy_document.appsync_dynamodb_access.json
}
