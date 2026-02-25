/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
API Tables Module - DynamoDB Tables

Creates:
- Sessions table for chat session storage
- Favorite runtime table for user preferences
*/

locals {
  name_prefix = lower(var.prefix)
}

# -----------------------------------------------------------------------------
# Sessions Table
# Stores chat session data with user associations
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "sessions" {
  name         = "${local.name_prefix}-sessionsTable"
  billing_mode = "PAY_PER_REQUEST"

  # Note: hash_key/range_key deprecated in AWS provider v6 but key_schema not yet available
  hash_key  = "SessionId"
  range_key = "UserId"

  attribute {
    name = "SessionId"
    type = "S"
  }

  attribute {
    name = "UserId"
    type = "S"
  }

  # Global Secondary Index for querying by user
  global_secondary_index {
    name = "byUserId"
    key_schema {
      attribute_name = "UserId"
      key_type       = "HASH"
    }
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-sessionsTable"
  })
}

# -----------------------------------------------------------------------------
# Favorite Runtime Table
# Stores user preferences for runtime configurations
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "favorite_runtime" {
  name         = "${local.name_prefix}-favoriteRuntimeTable"
  billing_mode = "PAY_PER_REQUEST"

  # Note: hash_key deprecated in AWS provider v6 but key_schema not yet available
  hash_key = "UserId"

  attribute {
    name = "UserId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-favoriteRuntimeTable"
  })
}

# -----------------------------------------------------------------------------
# Evaluators Table
# Stores evaluation configurations and results
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "evaluators" {
  name         = "${local.name_prefix}-evaluatorsTable"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "EvaluatorName"

  attribute {
    name = "EvaluatorName"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluatorsTable"
  })
}
