/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AppSync Module - GraphQL API

Creates:
- AppSync GraphQL API with Cognito and IAM authentication
- IAM role for CloudWatch logging
- CloudWatch log group for API logs
*/

locals {
  name_prefix = lower(var.prefix)

  # Use provided schema content or read from file
  schema = var.schema_content != null ? var.schema_content : (
    var.schema_file_path != null ? file(var.schema_file_path) : ""
  )
}

# Get current region
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# IAM Role for AppSync Logging
# -----------------------------------------------------------------------------

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

resource "aws_iam_role" "appsync_logging" {
  name               = "${local.name_prefix}-appsync-logging-role"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-logging-role"
  })
}

resource "aws_iam_role_policy_attachment" "appsync_logging" {
  role       = aws_iam_role.appsync_logging.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group for AppSync
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "appsync" {
  # checkov:skip=CKV_AWS_338:Log retention configurable via variable, default is 365 days
  name              = "/aws/appsync/apis/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-logs"
  })
}

# -----------------------------------------------------------------------------
# AppSync GraphQL API
# -----------------------------------------------------------------------------

resource "aws_appsync_graphql_api" "main" {
  # checkov:skip=CKV2_AWS_33:WAF protection is optional and can be added separately if needed
  name                = "${local.name_prefix}-api"
  authentication_type = "AMAZON_COGNITO_USER_POOLS"

  # Primary auth: Cognito User Pool
  user_pool_config {
    user_pool_id   = var.user_pool_id
    default_action = "ALLOW"
    aws_region     = data.aws_region.current.id
  }

  # Additional auth: IAM (for service-to-service calls)
  additional_authentication_provider {
    authentication_type = "AWS_IAM"
  }

  # GraphQL schema
  schema = local.schema

  # Logging configuration
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logging.arn
    field_log_level          = "ALL"
    exclude_verbose_content  = false
  }

  # X-Ray tracing
  xray_enabled = true

  # Public visibility (change to PRIVATE for VPC-only access)
  visibility = "GLOBAL"

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-api"
  })

  depends_on = [aws_cloudwatch_log_group.appsync]
}
