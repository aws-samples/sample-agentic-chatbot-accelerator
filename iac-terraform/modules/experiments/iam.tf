/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - IAM Roles

Creates:
- Batch service role for managing compute environments
- Batch job role for container task permissions (DynamoDB, S3, Bedrock)
- Batch execution role for ECS task execution (ECR pull, CloudWatch logs)
- Lambda resolver IAM role and policies
- AppSync data source IAM role
*/

# -----------------------------------------------------------------------------
# Batch Service Role
# For Fargate-based compute environments, AWS Batch uses the
# service-linked role (AWSServiceRoleForBatch) automatically.
# This matches CDK's FargateComputeEnvironment behavior which
# does not create a custom service role.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Batch Job Role
# Permissions for the container running inside Fargate
# -----------------------------------------------------------------------------

resource "aws_iam_role" "batch_job" {
  name = "${local.name_prefix}-experiments-batch-job"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-experiments-batch-job" })
}

resource "aws_iam_role_policy" "batch_job" {
  name = "${local.name_prefix}-experiments-batch-job-policy"
  role = aws_iam_role.batch_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DynamoDBAccess"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = [var.experiments_table_arn]
      },
      {
        Sid      = "KMSAccess"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.kms_key_arn]
      },
      {
        Sid      = "S3Access"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${var.evaluations_bucket_arn}/*"]
      },
      {
        Sid    = "BedrockAccess"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
          "arn:aws:bedrock:*::inference-profile/*"
        ]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Batch Execution Role
# Allows ECS to pull images from ECR and write logs
# -----------------------------------------------------------------------------

resource "aws_iam_role" "batch_execution" {
  name = "${local.name_prefix}-experiments-batch-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-experiments-batch-exec" })
}

resource "aws_iam_role_policy_attachment" "batch_execution" {
  role       = aws_iam_role.batch_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# -----------------------------------------------------------------------------
# Lambda Resolver Role
# Permissions for the experiment resolver Lambda function
# -----------------------------------------------------------------------------

resource "aws_iam_role" "experiment_resolver" {
  name = "${local.name_prefix}-experiment-resolver-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-experiment-resolver-role" })
}

resource "aws_iam_role_policy_attachment" "experiment_resolver_basic" {
  role       = aws_iam_role.experiment_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "experiment_resolver_xray" {
  role       = aws_iam_role.experiment_resolver.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "experiment_resolver" {
  name = "${local.name_prefix}-experiment-resolver-policy"
  role = aws_iam_role.experiment_resolver.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query"
        ]
        Resource = [
          var.experiments_table_arn,
          "${var.experiments_table_arn}/index/*"
        ]
      },
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          var.evaluations_bucket_arn,
          "${var.evaluations_bucket_arn}/*"
        ]
      },
      {
        Sid      = "KMSAccess"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.kms_key_arn]
      },
      {
        Sid    = "BatchAccess"
        Effect = "Allow"
        Action = ["batch:SubmitJob", "batch:DescribeJobs", "batch:TerminateJob"]
        Resource = [
          aws_batch_job_queue.experiments.arn,
          "arn:aws:batch:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:job-definition/${aws_batch_job_definition.experiments.name}",
          "arn:aws:batch:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:job-definition/${aws_batch_job_definition.experiments.name}:*"
        ]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# AppSync Data Source Role
# Allows AppSync to invoke the experiment resolver Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "appsync_experiment_ds" {
  name = "${local.name_prefix}-appsync-exp-ds-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "appsync.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-appsync-exp-ds-role" })
}

resource "aws_iam_role_policy" "appsync_experiment_ds" {
  name = "${local.name_prefix}-appsync-exp-ds-policy"
  role = aws_iam_role.appsync_experiment_ds.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["lambda:InvokeFunction"]
      Resource = [
        aws_lambda_function.experiment_resolver.arn,
        "${aws_lambda_function.experiment_resolver.arn}:*"
      ]
    }]
  })
}
