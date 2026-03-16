/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - CodeBuild for Evaluation Executor Lambda Package

Replaces the local Docker pip-install with AWS CodeBuild.
Lambda packages are built in the cloud — no local Docker required.

Creates:
- S3 objects for source code upload (build context)
- CodeBuild project for pip install + zip
- IAM role for CodeBuild
- null_resource that triggers builds only when source files change
*/

# -----------------------------------------------------------------------------
# Local Values for CodeBuild
# -----------------------------------------------------------------------------

locals {
  executor_source_dir = "${local.functions_dir}/evaluation-executor"

  # Content-based hash for change detection
  executor_source_hash = sha256(join("", [
    filesha256("${local.executor_source_dir}/evaluator.py"),
    filesha256("${local.executor_source_dir}/index.py"),
  ]))

  # S3 keys for build context and artifact
  executor_source_s3_key   = "codebuild/source/evaluation-executor-${local.executor_source_hash}.zip"
  executor_artifact_s3_key = "lambda-code/evaluation-executor.zip"
}

# -----------------------------------------------------------------------------
# Upload Source Files to S3 as Build Context
# Uses archive_file + aws_s3_object so Terraform tracks the content hash
# and only re-uploads when source files change.
# -----------------------------------------------------------------------------

data "archive_file" "executor_source_context" {
  type        = "zip"
  source_dir  = local.executor_source_dir
  output_path = "${path.module}/../../../iac-terraform/build/.evaluation-executor-context.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

resource "aws_s3_object" "executor_source_context" {
  bucket = aws_s3_bucket.evaluations.id
  key    = local.executor_source_s3_key
  source = data.archive_file.executor_source_context.output_path
  etag   = data.archive_file.executor_source_context.output_md5

  depends_on = [data.archive_file.executor_source_context]
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# Permissions: S3 read (source) + write (artifact), CloudWatch Logs, KMS
# -----------------------------------------------------------------------------

resource "aws_iam_role" "codebuild_executor" {
  name = "${local.name_prefix}-codebuild-eval-executor"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "codebuild.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-codebuild-eval-executor"
  })
}

resource "aws_iam_role_policy" "codebuild_executor" {
  name = "${local.name_prefix}-codebuild-eval-executor-policy"
  role = aws_iam_role.codebuild_executor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch Logs — write build logs
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = [
          "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${local.name_prefix}-*",
          "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${local.name_prefix}-*:*"
        ]
      },
      # S3 — read source context + write artifact
      {
        Sid    = "S3ReadSource"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetBucketLocation",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.evaluations.arn,
          "${aws_s3_bucket.evaluations.arn}/*"
        ]
      },
      {
        Sid    = "S3WriteArtifact"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetBucketLocation"
        ]
        Resource = [
          aws_s3_bucket.evaluations.arn,
          "${aws_s3_bucket.evaluations.arn}/*"
        ]
      },
      # KMS — decrypt/encrypt S3 objects
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Evaluation Executor Lambda Package
# Installs strands-agents-evals + copies source files → zip artifact on S3
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "evaluation_executor" {
  name         = "${local.name_prefix}-eval-executor-builder"
  description  = "Builds the evaluation executor Lambda package (pip install + zip)"
  service_role = aws_iam_role.codebuild_executor.arn

  build_timeout = 15 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.evaluations.id}/${local.executor_source_s3_key}"

    buildspec = templatefile("${path.module}/buildspec-pip.yml.tpl", {
      pip_packages    = "strands-agents-evals"
      output_zip_name = "evaluation-executor.zip"
    })
  }

  artifacts {
    type                   = "S3"
    location               = aws_s3_bucket.evaluations.id
    path                   = ""
    name                   = "lambda-code"
    packaging              = "NONE"
    override_artifact_name = true
  }

  environment {
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = var.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type         = var.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-eval-executor-builder"
    }
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-eval-executor-builder"
  })
}

# -----------------------------------------------------------------------------
# Trigger: Build Evaluation Executor Package (only when source changes)
# The executor_source_hash changes only when .py source files change.
# When it changes, Terraform recreates this null_resource → starts a build.
# -----------------------------------------------------------------------------

resource "null_resource" "build_evaluation_executor" {
  triggers = {
    source_hash = local.executor_source_hash
    buildspec_hash = sha256(templatefile("${path.module}/buildspec-pip.yml.tpl", {
      pip_packages    = "strands-agents-evals"
      output_zip_name = "evaluation-executor.zip"
    }))
    project_config = aws_codebuild_project.evaluation_executor.id
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for evaluation executor package (hash: ${local.executor_source_hash})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.evaluation_executor.name}" \
        --source-location-override "${aws_s3_bucket.evaluations.id}/${local.executor_source_s3_key}" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Evaluation executor package build succeeded!"
            break
            ;;
          FAILED|FAULT|STOPPED|TIMED_OUT)
            echo "❌ Build failed with status: $STATUS"
            LOG_URL=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
              --query 'builds[0].logs.deepLink' --output text)
            echo "Build logs: $LOG_URL"
            exit 1
            ;;
          *)
            echo "  Build status: $STATUS (waiting...)"
            sleep 15
            ;;
        esac
      done
    EOT
  }

  depends_on = [
    aws_codebuild_project.evaluation_executor,
    aws_s3_object.executor_source_context,
    aws_iam_role_policy.codebuild_executor
  ]
}
