/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Knowledge Base APIs Module - Main Resources

Creates:
- Lambda function for Knowledge Base operations resolver
- IAM role and policy for Lambda execution
- AppSync data source and resolvers
- OpenSearch Serverless access policy

Equivalent to: KnowledgeBaseOps construct in lib/api/knowledge-base.ts
*/

locals {
  name_prefix = lower(var.prefix)

  # Lambda function name
  function_name = "${local.name_prefix}-knowledgeBaseResolver"

  # Operations this resolver handles (matches CDK OPS_PROPS)
  kb_operations = [
    # Queries
    { type = "Query", field = "listKnowledgeBases" },
    { type = "Query", field = "listDataSources" },
    { type = "Query", field = "listDocuments" },
    { type = "Query", field = "getInputPrefix" },
    { type = "Query", field = "checkOnProcessStarted" },
    { type = "Query", field = "checkOnProcessCompleted" },
    { type = "Query", field = "checkOnDocumentsRemoved" },
    { type = "Query", field = "checkOnSyncInProgress" },
    { type = "Query", field = "getDocumentMetadata" },
    { type = "Query", field = "getPresignedUrl" },
    # Mutations
    { type = "Mutation", field = "deleteDocument" },
    { type = "Mutation", field = "createKnowledgeBase" },
    { type = "Mutation", field = "createDataSource" },
    { type = "Mutation", field = "deleteKnowledgeBase" },
    { type = "Mutation", field = "deleteDataSource" },
    { type = "Mutation", field = "syncKnowledgeBase" },
    { type = "Mutation", field = "updateMetadata" },
    { type = "Mutation", field = "batchUpdateMetadata" },
  ]
}

# Get current AWS account and region
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "kb_resolver" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 365
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-kb-resolver-logs"
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

resource "aws_iam_role" "kb_resolver" {
  name               = "${local.name_prefix}-kb-resolver-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-kb-resolver-role"
  })
}

# IAM Policy for Lambda
data "aws_iam_policy_document" "kb_resolver" {
  # CloudWatch Logs
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${aws_cloudwatch_log_group.kb_resolver.arn}:*"]
  }

  # X-Ray Tracing
  statement {
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords"
    ]
    resources = ["*"]
  }

  # OpenSearch Serverless API Access
  statement {
    actions   = ["aoss:APIAccessAll"]
    resources = [var.collection_arn]
  }

  # Pass Role (for creating KBs)
  statement {
    actions   = ["iam:PassRole"]
    resources = [var.kb_role_arn]
  }

  # EventBridge (for sync rules)
  statement {
    actions = [
      "events:PutRule",
      "events:PutTargets",
      "events:DeleteRule",
      "events:ListTargetsByRule",
      "events:RemoveTargets",
      "events:TagResource"
    ]
    resources = [
      "arn:aws:events:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:rule/*"
    ]
  }

  # S3 Data Bucket
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging"
    ]
    resources = [
      var.data_bucket_arn,
      "${var.data_bucket_arn}/*"
    ]
  }

  # DynamoDB - Document State Table
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem"
    ]
    resources = [var.document_table_arn]
  }

  # DynamoDB - KB Inventory Table
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ]
    resources = [var.kb_inventory_table_arn]
  }

  # SQS - Pipeline Start Queue
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.queue_start_pipeline_arn]
  }

  # Bedrock Knowledge Base Operations
  statement {
    actions = [
      "bedrock:ListKnowledgeBases",
      "bedrock:ListTagsForResource",
      "bedrock:ListDataSources",
      "bedrock:ListIngestionJobs",
      "bedrock:GetDataSource",
      "bedrock:CreateKnowledgeBase",
      "bedrock:GetKnowledgeBase",
      "bedrock:DeleteKnowledgeBase",
      "bedrock:TagResource",
      "bedrock:CreateDataSource",
      "bedrock:DeleteDataSource",
      "bedrock:StartIngestionJob"
    ]
    resources = [
      "arn:aws:bedrock:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
    ]
  }

  # KMS
  statement {
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*"
    ]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "kb_resolver" {
  name   = "${local.name_prefix}-kb-resolver-policy"
  role   = aws_iam_role.kb_resolver.id
  policy = data.aws_iam_policy_document.kb_resolver.json
}

# -----------------------------------------------------------------------------
# OpenSearch Serverless Access Policy for Lambda
# Allows Lambda to manage indexes
# -----------------------------------------------------------------------------

resource "aws_opensearchserverless_access_policy" "lambda_access" {
  name = "${substr(local.name_prefix, 0, min(length(local.name_prefix), 20))}-pol-from-lambda"
  type = "data"

  policy = jsonencode([
    {
      Rules = [
        {
          Resource     = ["index/${var.collection_name}/*"]
          Permission   = ["aoss:DescribeIndex", "aoss:CreateIndex", "aoss:DeleteIndex"]
          ResourceType = "index"
        },
        {
          Resource     = ["collection/${var.collection_name}"]
          Permission   = ["aoss:DescribeCollectionItems"]
          ResourceType = "collection"
        }
      ]
      Principal   = [aws_iam_role.kb_resolver.arn]
      Description = "Accessing from Lambda function"
    }
  ])
}

# -----------------------------------------------------------------------------
# Lambda Function
# -----------------------------------------------------------------------------

data "archive_file" "kb_resolver" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lib/api/functions/knowledge-base-resolver"
  output_path = "${path.module}/../../build/knowledge-base-resolver.zip"
}

resource "aws_lambda_function" "kb_resolver" {
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_116:DLQ not required for synchronous AppSync resolver
  # checkov:skip=CKV_AWS_117:VPC not required for this Lambda
  # checkov:skip=CKV_AWS_272:Code signing not required for internal Lambda
  function_name = local.function_name
  role          = aws_iam_role.kb_resolver.arn
  handler       = "index.handler"
  runtime       = var.python_runtime
  timeout       = 900 # 15 minutes for KB operations
  memory_size   = 128

  filename         = data.archive_file.kb_resolver.output_path
  source_code_hash = data.archive_file.kb_resolver.output_base64sha256

  architectures = [var.lambda_architecture]

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn
  ]

  environment {
    variables = {
      LOG_LEVEL                    = "INFO"
      POWERTOOLS_SERVICE_NAME      = "kb-resolver"
      POWERTOOLS_METRICS_NAMESPACE = local.name_prefix
      DOCUMENT_TABLE_NAME          = var.document_table_name
      KB_INVENTORY_TABLE_NAME      = var.kb_inventory_table_name
      KB_ROLE_ARN                  = var.kb_role_arn
      COLLECTION_ID                = var.collection_id
      DATA_BUCKET_ARN              = var.data_bucket_arn
      START_PIPELINE_QUEUE_ARN     = var.queue_start_pipeline_arn
      STACK_NAME                   = var.stack_tag
      ENV_PREFIX                   = var.environment_tag != "" ? var.environment_tag : "_tag"
      REGION_NAME                  = data.aws_region.current.id
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.kb_resolver,
    aws_iam_role_policy.kb_resolver
  ]

  tags = merge(var.tags, {
    Name = local.function_name
  })
}

# -----------------------------------------------------------------------------
# AppSync Data Source
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "kb_resolver" {
  api_id           = var.appsync_api_id
  name             = "${replace(local.name_prefix, "-", "_")}_knowledgeBaseOpsLambdaDataSource"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_datasource.arn

  lambda_config {
    function_arn = aws_lambda_function.kb_resolver.arn
  }
}

# IAM Role for AppSync to invoke Lambda
resource "aws_iam_role" "appsync_datasource" {
  name = "${local.name_prefix}-kb-appsync-ds-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "appsync.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-kb-appsync-ds-role"
  })
}

resource "aws_iam_role_policy" "appsync_datasource" {
  name = "${local.name_prefix}-kb-appsync-ds-policy"
  role = aws_iam_role.appsync_datasource.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.kb_resolver.arn
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# AppSync Resolvers
# One resolver per operation
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "kb_operations" {
  for_each = { for op in local.kb_operations : op.field => op }

  api_id      = var.appsync_api_id
  type        = each.value.type
  field       = each.value.field
  data_source = aws_appsync_datasource.kb_resolver.name
}
