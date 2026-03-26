/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - Lambda Functions

Creates:
- Experiment resolver Lambda function (always deployed)
- CloudWatch log group for the resolver
*/

# -----------------------------------------------------------------------------
# Lambda Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "experiment_resolver" {
  name              = "/aws/lambda/${local.name_prefix}-experiment-resolver"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiment-resolver-logs"
  })
}

# -----------------------------------------------------------------------------
# Package Lambda Code
# -----------------------------------------------------------------------------

data "archive_file" "experiment_resolver" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/experiment-resolver"
  output_path = "${path.module}/../../build/experiment-resolver.zip"
}

# -----------------------------------------------------------------------------
# Experiment Resolver Lambda
# Handles all experiment GraphQL operations (CRUD + runExperiment)
# When Batch is disabled, runExperiment will return an error indicating
# that automated generation is unavailable.
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "experiment_resolver" {
  # checkov:skip=CKV_AWS_116:DLQ not needed for synchronous AppSync resolver
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name    = "${local.name_prefix}-experiment-resolver"
  role             = aws_iam_role.experiment_resolver.arn
  handler          = "index.handler"
  runtime          = var.python_runtime
  timeout          = 30
  memory_size      = 128
  filename         = data.archive_file.experiment_resolver.output_path
  source_code_hash = data.archive_file.experiment_resolver.output_base64sha256

  architectures = [var.lambda_architecture]

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
  ]

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      EXPERIMENTS_TABLE_NAME  = var.experiments_table_name
      EXPERIMENTS_BUCKET_NAME = var.evaluations_bucket_name
      ACCOUNT_ID              = data.aws_caller_identity.current.account_id
      BATCH_JOB_QUEUE         = aws_batch_job_queue.experiments.name
      BATCH_JOB_DEFINITION    = aws_batch_job_definition.experiments.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.experiment_resolver,
    aws_iam_role.experiment_resolver,
  ]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiment-resolver"
  })
}
