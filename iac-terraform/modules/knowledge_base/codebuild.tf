# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Knowledge Base Module - CodeBuild for Vector Index Creator Lambda Package
#
# Replaces the local Docker pip-install with AWS CodeBuild.
# Lambda packages are built in the cloud — no local Docker required.
#
# Creates:
# - S3 bucket for build context and artifacts
# - S3 objects for source code upload (build context)
# - CodeBuild project for pip install + zip
# - IAM role for CodeBuild
# - null_resource that triggers builds only when source files change
# -------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Local Values for CodeBuild
# -----------------------------------------------------------------------------

locals {
  vector_index_source_dir = "${path.module}/lambdas/create-vector-index"

  # Content-based hash for change detection
  vector_index_source_hash = sha256(join("", [
    filesha256("${local.vector_index_source_dir}/index.py"),
    filesha256("${local.vector_index_source_dir}/requirements.txt"),
  ]))

  # S3 keys for build context and artifact
  vector_index_source_s3_key   = "source/create-vector-index-${local.vector_index_source_hash}.zip"
  vector_index_artifact_s3_key = "artifacts/create-vector-index.zip"

  # Name prefix for CodeBuild resources
  kb_name_prefix = lower(var.prefix)
}

# -----------------------------------------------------------------------------
# S3 Bucket for Build Context & Artifacts
# KB module doesn't have an existing bucket to reuse, so we create a small one.
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "kb_build" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for temporary build artifacts
  # checkov:skip=CKV_AWS_18:Access logging not needed for temporary build artifacts
  # checkov:skip=CKV2_AWS_62:Event notifications not needed for build context bucket
  count = var.enabled ? 1 : 0

  bucket        = "${local.kb_name_prefix}-kb-codebuild-${local.account_id}"
  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.kb_name_prefix}-kb-codebuild"
  })
}

resource "aws_s3_bucket_versioning" "kb_build" {
  count  = var.enabled ? 1 : 0
  bucket = aws_s3_bucket.kb_build[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "kb_build" {
  count  = var.enabled ? 1 : 0
  bucket = aws_s3_bucket.kb_build[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null ? true : false
  }
}

resource "aws_s3_bucket_public_access_block" "kb_build" {
  count                   = var.enabled ? 1 : 0
  bucket                  = aws_s3_bucket.kb_build[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "kb_build" {
  count  = var.enabled ? 1 : 0
  bucket = aws_s3_bucket.kb_build[0].id

  rule {
    id     = "expire-old-contexts"
    status = "Enabled"

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# -----------------------------------------------------------------------------
# Upload Source Files to S3 as Build Context
# Uses archive_file + aws_s3_object so Terraform tracks the content hash
# and only re-uploads when source files change.
# -----------------------------------------------------------------------------

data "archive_file" "vector_index_source_context" {
  count = var.enabled ? 1 : 0

  type        = "zip"
  source_dir  = local.vector_index_source_dir
  output_path = "${path.module}/build/.vector-index-source-context.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

resource "aws_s3_object" "vector_index_source_context" {
  count = var.enabled ? 1 : 0

  bucket = aws_s3_bucket.kb_build[0].id
  key    = local.vector_index_source_s3_key
  source = data.archive_file.vector_index_source_context[0].output_path
  etag   = data.archive_file.vector_index_source_context[0].output_md5

  depends_on = [data.archive_file.vector_index_source_context]
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# Permissions: S3 read (source) + write (artifact), CloudWatch Logs, KMS
# -----------------------------------------------------------------------------

resource "aws_iam_role" "codebuild_vector_index" {
  count = var.enabled ? 1 : 0

  name = "${local.kb_name_prefix}-codebuild-vector-index"

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
    Name = "${local.kb_name_prefix}-codebuild-vector-index"
  })
}

resource "aws_iam_role_policy" "codebuild_vector_index" {
  count = var.enabled ? 1 : 0

  name = "${local.kb_name_prefix}-codebuild-vector-index-policy"
  role = aws_iam_role.codebuild_vector_index[0].id

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
          "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${local.kb_name_prefix}-*",
          "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${local.kb_name_prefix}-*:*"
        ]
      },
      # S3 — read source context + write artifact
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.kb_build[0].arn,
          "${aws_s3_bucket.kb_build[0].arn}/*"
        ]
      },
      # KMS — decrypt/encrypt S3 objects (conditional)
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = var.kms_key_arn != null ? [var.kms_key_arn] : ["*"]
        Condition = var.kms_key_arn != null ? {} : {
          StringEquals = {
            "kms:ViaService" = "s3.${local.region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Vector Index Creator Lambda Package
# Installs opensearch-py + requests-aws4auth, copies source → zip artifact on S3
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "vector_index_builder" {
  count = var.enabled ? 1 : 0

  name         = "${local.kb_name_prefix}-vector-index-builder"
  description  = "Builds the vector index creator Lambda package (pip install + zip)"
  service_role = aws_iam_role.codebuild_vector_index[0].arn

  build_timeout = 15 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.kb_build[0].id}/${local.vector_index_source_s3_key}"

    buildspec = templatefile("${path.module}/buildspec-pip.yml.tpl", {
      pip_packages    = "-r requirements.txt"
      output_zip_name = "create-vector-index.zip"
    })
  }

  artifacts {
    type                   = "S3"
    location               = aws_s3_bucket.kb_build[0].id
    path                   = ""
    name                   = "artifacts"
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
      group_name = "/aws/codebuild/${local.kb_name_prefix}-vector-index-builder"
    }
  }

  tags = merge(var.tags, {
    Name = "${local.kb_name_prefix}-vector-index-builder"
  })
}

# -----------------------------------------------------------------------------
# Trigger: Build Vector Index Lambda Package (only when source changes)
# The vector_index_source_hash changes only when source files change.
# When it changes, Terraform recreates this null_resource → starts a build.
# -----------------------------------------------------------------------------

resource "null_resource" "build_vector_index_lambda" {
  count = var.enabled ? 1 : 0

  triggers = {
    source_hash = local.vector_index_source_hash
    buildspec_hash = sha256(templatefile("${path.module}/buildspec-pip.yml.tpl", {
      pip_packages    = "-r requirements.txt"
      output_zip_name = "create-vector-index.zip"
    }))
    project_config = aws_codebuild_project.vector_index_builder[0].id
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for vector index Lambda package (hash: ${local.vector_index_source_hash})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.vector_index_builder[0].name}" \
        --source-location-override "${aws_s3_bucket.kb_build[0].id}/${local.vector_index_source_s3_key}" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Vector index Lambda package build succeeded!"
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
    aws_codebuild_project.vector_index_builder,
    aws_s3_object.vector_index_source_context,
    aws_iam_role_policy.codebuild_vector_index
  ]
}
