/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - CodeBuild Image Builder

Builds the experiments Batch Docker image in the cloud via AWS CodeBuild.
No local Docker required. Follows the same pattern as agent_core/codebuild.tf.

Creates:
- S3 bucket for Docker build context upload
- CodeBuild project for experiments Batch image
- IAM role for CodeBuild
- null_resource that triggers builds only when source files change
*/

# -----------------------------------------------------------------------------
# Content-based tag: changes only when Docker source files change
# -----------------------------------------------------------------------------

locals {
  experiments_docker_hash = sha256(join("", [
    for f in sort(fileset(local.docker_dir, "**")) :
    filesha256("${local.docker_dir}/${f}")
  ]))
  experiments_content_tag = "exp-${substr(local.experiments_docker_hash, 0, 16)}"
}

# -----------------------------------------------------------------------------
# S3 Bucket for Docker Build Context
# Holds zipped Docker directory uploaded by Terraform
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "build_context" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for temporary build context
  # checkov:skip=CKV_AWS_18:Access logging not needed for temporary build artifacts
  # checkov:skip=CKV2_AWS_62:Event notifications not needed for build context bucket
  bucket        = "${local.name_prefix}-exp-codebuild-ctx-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-exp-codebuild-context"
  })
}

resource "aws_s3_bucket_versioning" "build_context" {
  bucket = aws_s3_bucket.build_context.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build_context" {
  bucket = aws_s3_bucket.build_context.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "build_context" {
  bucket                  = aws_s3_bucket.build_context.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "build_context" {
  bucket = aws_s3_bucket.build_context.id

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
# Upload Docker Build Context to S3
# Uses archive_file + aws_s3_object so Terraform tracks the content hash
# and only re-uploads when source files change.
# -----------------------------------------------------------------------------

data "archive_file" "experiments_docker_context" {
  type        = "zip"
  source_dir  = local.docker_dir
  output_path = "${path.module}/../../build/.experiments-docker-context.zip"
  excludes    = [".git", "__pycache__", "*.pyc"]
}

resource "aws_s3_object" "experiments_docker_context" {
  bucket = aws_s3_bucket.build_context.id
  key    = "experiments-batch/${local.experiments_content_tag}.zip"
  source = data.archive_file.experiments_docker_context.output_path
  etag   = data.archive_file.experiments_docker_context.output_md5

  depends_on = [data.archive_file.experiments_docker_context]
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# Permissions: ECR push, S3 read, CloudWatch Logs, KMS
# -----------------------------------------------------------------------------

resource "aws_iam_role" "codebuild" {
  name = "${local.name_prefix}-exp-codebuild-builder"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-exp-codebuild-builder"
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${local.name_prefix}-exp-codebuild-builder-policy"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch Logs — write build logs
      {
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
      # S3 — read build context
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetBucketLocation",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.build_context.arn,
          "${aws_s3_bucket.build_context.arn}/*"
        ]
      },
      # ECR — authenticate and push images
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = [aws_ecr_repository.experiments.arn]
      },
      # KMS — decrypt S3 objects
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Experiments Batch Image
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "experiments_image_builder" {
  # checkov:skip=CKV_AWS_316:Privileged mode required for Docker-in-Docker builds
  name         = "${local.name_prefix}-exp-image-builder"
  description  = "Builds and pushes the experiments Batch Docker image to ECR"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 30 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/experiments-batch/${local.experiments_content_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-image.yml.tpl", {
      ecr_repo_url    = aws_ecr_repository.experiments.repository_url
      aws_region      = data.aws_region.current.id
      account_id      = data.aws_caller_identity.current.account_id
      dockerfile_path = "Dockerfile"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = true # Required for Docker builds

    environment_variable {
      name  = "IMAGE_TAG"
      value = local.experiments_content_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-exp-image-builder"
    }
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-exp-image-builder"
  })
}

# -----------------------------------------------------------------------------
# IAM Propagation Delay
# IAM policies take a few seconds to propagate globally. Without this sleep,
# CodeBuild builds can fail with ACCESS_DENIED on logs:CreateLogStream.
# -----------------------------------------------------------------------------

resource "time_sleep" "wait_for_iam_propagation" {
  depends_on      = [aws_iam_role_policy.codebuild]
  create_duration = "15s"
}

# -----------------------------------------------------------------------------
# Trigger: Build Experiments Image (only when source changes)
# The experiments_content_tag changes only when Docker source files change.
# When it changes, Terraform recreates this null_resource → starts a build.
# -----------------------------------------------------------------------------

resource "null_resource" "build_experiments_image" {
  triggers = {
    source_hash = local.experiments_content_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      AWS_PROFILE = var.aws_profile
    }
    command = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for experiments Batch image (tag: ${local.experiments_content_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.experiments_image_builder.name}" \
        --source-location-override "${aws_s3_bucket.build_context.id}/experiments-batch/${local.experiments_content_tag}.zip" \
        --environment-variables-override "name=IMAGE_TAG,value=${local.experiments_content_tag},type=PLAINTEXT" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Experiments Batch image build succeeded!"
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
    aws_codebuild_project.experiments_image_builder,
    aws_s3_object.experiments_docker_context,
    aws_ecr_repository.experiments,
    time_sleep.wait_for_iam_propagation
  ]
}
