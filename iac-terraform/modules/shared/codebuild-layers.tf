/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Shared Module - CodeBuild Artifact Builder

Builds Lambda layers and TypeScript Lambdas in AWS CodeBuild.
This eliminates the need for Docker or Node.js on the deployment machine.

Creates:
- S3 bucket for build context and output artifacts
- CodeBuild project for boto3 Lambda layer (Python)
- CodeBuild project for notify-runtime-update Lambda (TypeScript)
- IAM role for CodeBuild
- Triggers that rebuild only when source files change

Note: genai-core layer is pure Python and built directly by Terraform's
archive_file data source (no pip install required).
*/

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current_region" {}

# -----------------------------------------------------------------------------
# Local Variables
# -----------------------------------------------------------------------------

locals {
  # Source paths for layers
  boto3_requirements_path = "${path.module}/../../../lib/shared/layers/boto3-latest/requirements.txt"
  genai_core_source_path  = "${path.module}/../../../lib/shared/layers/python-sdk/genai_core"

  # Source path for TypeScript Lambda
  notify_runtime_update_path = "${path.module}/../../../lib/api/functions/notify-runtime-update"

  # Content-based tags for change detection
  boto3_content_hash     = filesha256(local.boto3_requirements_path)
  boto3_content_tag      = substr(local.boto3_content_hash, 0, 12)
  genai_core_content_tag = substr(sha256(join("", [for f in fileset(local.genai_core_source_path, "**/*.py") : filesha256("${local.genai_core_source_path}/${f}")])), 0, 12)

  # TypeScript Lambda content hash
  notify_runtime_update_content_tag = substr(sha256(join("", [for f in fileset(local.notify_runtime_update_path, "*.ts") : filesha256("${local.notify_runtime_update_path}/${f}")])), 0, 12)

  # Python version without 'python' prefix for buildspec
  python_version_short = replace(var.python_runtime, "python", "")
}

# -----------------------------------------------------------------------------
# S3 Bucket for Layer Build Context & Output
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "layer_builds" {
  bucket        = "${local.name_prefix}-layer-builds-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = {
    Name = "${local.name_prefix}-layer-builds"
  }
}

resource "aws_s3_bucket_versioning" "layer_builds" {
  bucket = aws_s3_bucket.layer_builds.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "layer_builds" {
  bucket = aws_s3_bucket.layer_builds.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "layer_builds" {
  bucket                  = aws_s3_bucket.layer_builds.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "layer_builds" {
  bucket = aws_s3_bucket.layer_builds.id

  rule {
    id     = "expire-old-builds"
    status = "Enabled"

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# -----------------------------------------------------------------------------
# Upload boto3 requirements.txt to S3
# -----------------------------------------------------------------------------

resource "aws_s3_object" "boto3_requirements" {
  bucket = aws_s3_bucket.layer_builds.id
  key    = "boto3-layer/input/${local.boto3_content_tag}/requirements.txt"
  source = local.boto3_requirements_path
  etag   = filemd5(local.boto3_requirements_path)
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# -----------------------------------------------------------------------------

resource "aws_iam_role" "layer_builder" {
  name = "${local.name_prefix}-layer-builder"

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

  tags = {
    Name = "${local.name_prefix}-layer-builder"
  }
}

resource "aws_iam_role_policy" "layer_builder" {
  name = "${local.name_prefix}-layer-builder-policy"
  role = aws_iam_role.layer_builder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch Logs
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = [
          "arn:aws:logs:${data.aws_region.current_region.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${local.name_prefix}-*",
          "arn:aws:logs:${data.aws_region.current_region.id}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${local.name_prefix}-*:*"
        ]
      },
      # S3 — read input, write output
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.layer_builds.arn,
          "${aws_s3_bucket.layer_builds.arn}/*"
        ]
      },
      # KMS — encrypt/decrypt S3 objects
      {
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
# CodeBuild Project — boto3 Layer
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "boto3_layer_builder" {
  name         = "${local.name_prefix}-boto3-layer-builder"
  description  = "Builds the boto3 Lambda layer"
  service_role = aws_iam_role.layer_builder.arn

  build_timeout = 15 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.layer_builds.id}/boto3-layer/input/${local.boto3_content_tag}/"
    buildspec = templatefile("${path.module}/buildspec-layer.yml.tpl", {
      python_version = local.python_version_short
      output_bucket  = aws_s3_bucket.layer_builds.id
      output_key     = "boto3-layer/output/${local.boto3_content_tag}/layer.zip"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = false

    environment_variable {
      name  = "LAYER_TAG"
      value = local.boto3_content_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-boto3-layer-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-boto3-layer-builder"
  }
}

# -----------------------------------------------------------------------------
# Trigger: Build boto3 Layer (only when requirements.txt changes)
# -----------------------------------------------------------------------------

resource "null_resource" "build_boto3_layer" {
  triggers = {
    source_hash = local.boto3_content_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for boto3 layer (tag: ${local.boto3_content_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.boto3_layer_builder.name}" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ boto3 layer build succeeded!"
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
            sleep 10
            ;;
        esac
      done
    EOT
  }

  depends_on = [
    aws_codebuild_project.boto3_layer_builder,
    aws_s3_object.boto3_requirements
  ]
}

# -----------------------------------------------------------------------------
# GenAI Core Layer — Built directly with archive_file (pure Python, no pip)
# -----------------------------------------------------------------------------

data "archive_file" "genai_core_layer" {
  type        = "zip"
  output_path = "${path.module}/../../../iac-terraform/build/genai-core-layer.zip"

  # Lambda layers expect packages in a 'python' directory
  source {
    content  = ""
    filename = "python/.gitkeep"
  }

  dynamic "source" {
    for_each = fileset(local.genai_core_source_path, "**/*.py")
    content {
      content  = file("${local.genai_core_source_path}/${source.value}")
      filename = "python/genai_core/${source.value}"
    }
  }
}


# -----------------------------------------------------------------------------
# TypeScript Lambda — notify-runtime-update
# Built via CodeBuild using esbuild
# -----------------------------------------------------------------------------

# Upload TypeScript source files to S3
data "archive_file" "notify_runtime_update_source" {
  type        = "zip"
  source_dir  = local.notify_runtime_update_path
  output_path = "${path.module}/../../../iac-terraform/build/.notify-runtime-update-source.zip"
}

resource "aws_s3_object" "notify_runtime_update_source" {
  bucket = aws_s3_bucket.layer_builds.id
  key    = "notify-runtime-update/input/${local.notify_runtime_update_content_tag}/source.zip"
  source = data.archive_file.notify_runtime_update_source.output_path
  etag   = data.archive_file.notify_runtime_update_source.output_md5

  depends_on = [data.archive_file.notify_runtime_update_source]
}

# CodeBuild project for TypeScript Lambda
resource "aws_codebuild_project" "notify_runtime_update_builder" {
  name         = "${local.name_prefix}-notify-runtime-update-builder"
  description  = "Builds the notify-runtime-update TypeScript Lambda"
  service_role = aws_iam_role.layer_builder.arn

  build_timeout = 10 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.layer_builds.id}/notify-runtime-update/input/${local.notify_runtime_update_content_tag}/source.zip"
    buildspec = templatefile("${path.module}/buildspec-ts.yml.tpl", {
      output_bucket = aws_s3_bucket.layer_builds.id
      output_key    = "notify-runtime-update/output/${local.notify_runtime_update_content_tag}/lambda.zip"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false

    environment_variable {
      name  = "LAMBDA_TAG"
      value = local.notify_runtime_update_content_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-notify-runtime-update-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-notify-runtime-update-builder"
  }
}

# Trigger: Build TypeScript Lambda (only when source changes)
resource "null_resource" "build_notify_runtime_update" {
  triggers = {
    source_hash = local.notify_runtime_update_content_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for notify-runtime-update Lambda (tag: ${local.notify_runtime_update_content_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.notify_runtime_update_builder.name}" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ notify-runtime-update Lambda build succeeded!"
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
            sleep 10
            ;;
        esac
      done
    EOT
  }

  depends_on = [
    aws_codebuild_project.notify_runtime_update_builder,
    aws_s3_object.notify_runtime_update_source
  ]
}
