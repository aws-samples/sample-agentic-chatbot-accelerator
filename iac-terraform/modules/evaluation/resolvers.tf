/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - AppSync Resolvers

Creates:
- Lambda data source for the evaluation resolver
- Resolvers for 5 evaluation GraphQL operations
- None data source + resolvers for evaluation update pub/sub
*/

# -----------------------------------------------------------------------------
# AppSync Lambda Data Source
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "evaluation" {
  api_id           = var.appsync_api_id
  name             = "${replace(local.name_prefix, "-", "_")}_EvaluationDataSource"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_evaluation_ds.arn

  lambda_config {
    function_arn = aws_lambda_function.evaluation_resolver.arn
  }
}

resource "aws_iam_role" "appsync_evaluation_ds" {
  name = "${local.name_prefix}-appsync-eval-ds-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "appsync.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-appsync-eval-ds-role" })
}

resource "aws_iam_role_policy" "appsync_evaluation_ds" {
  name = "${local.name_prefix}-appsync-eval-ds-policy"
  role = aws_iam_role.appsync_evaluation_ds.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["lambda:InvokeFunction"]
      Resource = [
        aws_lambda_function.evaluation_resolver.arn,
        "${aws_lambda_function.evaluation_resolver.arn}:*"
      ]
    }]
  })
}

# -----------------------------------------------------------------------------
# AppSync Resolvers for Evaluation Operations
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "list_evaluators" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "listEvaluators"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "get_evaluator" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getEvaluator"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "create_evaluator" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "createEvaluator"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "delete_evaluator" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "deleteEvaluator"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "run_evaluation" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "runEvaluation"
  data_source = aws_appsync_datasource.evaluation.name
}
