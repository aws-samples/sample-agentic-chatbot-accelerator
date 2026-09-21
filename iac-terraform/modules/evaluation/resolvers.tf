/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - AppSync Resolvers

Creates:
- Lambda data source for the evaluation resolver
- Resolvers for 11 evaluation GraphQL operations
- None data source and JS resolvers for the run-status notification pair
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

resource "aws_appsync_resolver" "update_evaluator" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "updateEvaluator"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "start_evaluator_run" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "startEvaluatorRun"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "delete_evaluator_run" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "deleteEvaluatorRun"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "list_evaluator_runs" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "listEvaluatorRuns"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "get_evaluator_run" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getEvaluatorRun"
  data_source = aws_appsync_datasource.evaluation.name
}

resource "aws_appsync_resolver" "get_evaluator_test_cases" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getEvaluatorTestCases"
  data_source = aws_appsync_datasource.evaluation.name
}

# -----------------------------------------------------------------------------
# None Data Source + JS Resolvers for Run-Status Notifications
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "evaluation_none" {
  api_id = var.appsync_api_id
  name   = "evaluation_relay_source"
  type   = "NONE"
}

# Mutation.publishEvaluationUpdate was resolved by the http_api_resolver proxy loop
# until this module claimed it in outputs.tf. AppSync allows one resolver per
# type+field, and only api_id/type/field force replacement — so on an environment
# that has already applied the proxy version, move the existing resolver into this
# address before applying, or the create races the destroy:
#   terraform state mv \
#     'module.http_api_resolver.aws_appsync_resolver.mutation_resolvers["publishEvaluationUpdate"]' \
#     'module.evaluation.aws_appsync_resolver.publish_evaluation_update'
resource "aws_appsync_resolver" "publish_evaluation_update" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "publishEvaluationUpdate"
  data_source = aws_appsync_datasource.evaluation_none.name
  kind        = "UNIT"

  code = file("${local.functions_dir}/resolvers/evaluation-update/publish.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

resource "aws_appsync_resolver" "receive_evaluation_update" {
  api_id      = var.appsync_api_id
  type        = "Subscription"
  field       = "receiveEvaluationUpdate"
  data_source = aws_appsync_datasource.evaluation_none.name
  kind        = "UNIT"

  code = file("${local.functions_dir}/resolvers/evaluation-update/subscribe.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}
