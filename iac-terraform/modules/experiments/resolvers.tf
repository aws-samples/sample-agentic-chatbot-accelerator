/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - AppSync Resolvers

Creates:
- Lambda data source for the experiment resolver
- Resolvers for 7 experiment GraphQL operations
*/

# -----------------------------------------------------------------------------
# AppSync Lambda Data Source
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "experiment" {
  api_id           = var.appsync_api_id
  name             = "${replace(local.name_prefix, "-", "_")}_ExperimentDataSource"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.appsync_experiment_ds.arn

  lambda_config {
    function_arn = aws_lambda_function.experiment_resolver.arn
  }
}

# -----------------------------------------------------------------------------
# AppSync Resolvers for Experiment Operations
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "list_experiments" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "listExperiments"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "get_experiment" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getExperiment"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "get_experiment_presigned_url" {
  api_id      = var.appsync_api_id
  type        = "Query"
  field       = "getExperimentPresignedUrl"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "create_experiment" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "createExperiment"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "update_experiment" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "updateExperiment"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "delete_experiment" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "deleteExperiment"
  data_source = aws_appsync_datasource.experiment.name
}

resource "aws_appsync_resolver" "run_experiment" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "runExperiment"
  data_source = aws_appsync_datasource.experiment.name
}
