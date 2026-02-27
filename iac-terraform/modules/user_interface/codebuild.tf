/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - CodeBuild for React App

Creates:
- S3 bucket for build context (React source)
- CodeBuild project for building and deploying React app
- IAM role and policies for CodeBuild
*/

# -----------------------------------------------------------------------------
# Local variables for CodeBuild
# -----------------------------------------------------------------------------

locals {
  # Compute hash of React source files to detect changes
  react_source_hash = sha256(join("", concat(
    [filesha256("${local.react_app_path}/package.json")],
    [filesha256("${local.react_app_path}/package-lock.json")],
    [filesha256("${local.react_app_path}/vite.config.ts")],
    [filesha256("${local.react_app_path}/tsconfig.json")],
    [filesha256("${local.react_app_path}/index.html")],
    [for f in sort(fileset("${local.react_app_path}/src", "**")) : filesha256("${local.react_app_path}/src/${f}")]
  )))

  react_content_tag = substr(local.react_source_hash, 0, 12)

  # Hash of aws-exports.json content (triggers rebuild when config changes)
  config_hash = substr(sha256(local_file.aws_exports.content), 0, 12)
}

# -----------------------------------------------------------------------------
# S3 Bucket for Build Context
# Stores React source code and aws-exports.json for CodeBuild
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "build_context" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not required for build artifacts
  # checkov:skip=CKV_AWS_145:SSE-S3 encryption is sufficient for build artifacts
  # checkov:skip=CKV2_AWS_62:Event notifications not required for build artifacts
  # checkov:skip=CKV_AWS_18:Access logging not needed for temporary build artifacts
  bucket        = "${local.name_prefix}-ui-build-context-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = {
    Name = "${local.name_prefix}-ui-build-context"
  }
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
      sse_algorithm = "AES256"
    }
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
# Upload React Source to S3
# Uses archive_file so Terraform tracks content hash
# -----------------------------------------------------------------------------

data "archive_file" "react_source" {
  type        = "zip"
  source_dir  = local.react_app_path
  output_path = "${path.module}/../../../iac-terraform/build/.react-source-${local.react_content_tag}.zip"

  excludes = [
    "node_modules",
    "dist",
    ".vite",
    ".eslintcache"
  ]
}

resource "aws_s3_object" "react_source" {
  bucket = aws_s3_bucket.build_context.id
  key    = "react-source/${local.react_content_tag}.zip"
  source = data.archive_file.react_source.output_path
  etag   = data.archive_file.react_source.output_md5

  depends_on = [data.archive_file.react_source]
}

# -----------------------------------------------------------------------------
# Upload aws-exports.json to S3
# Separate from source so config changes trigger rebuild without re-uploading source
# -----------------------------------------------------------------------------

resource "aws_s3_object" "aws_exports" {
  bucket  = aws_s3_bucket.build_context.id
  key     = "config/aws-exports-${local.config_hash}.json"
  content = local_file.aws_exports.content

  depends_on = [local_file.aws_exports]
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# Permissions: S3 read (source), S3 write (website), CloudFront invalidation
# -----------------------------------------------------------------------------

resource "aws_iam_role" "codebuild" {
  name = "${local.name_prefix}-ui-codebuild"

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
    Name = "${local.name_prefix}-ui-codebuild"
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${local.name_prefix}-ui-codebuild-policy"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # CloudWatch Logs - write build logs
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
      # S3 - read build context (source and config)
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
      # S3 - write to website bucket
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.website.arn,
          "${aws_s3_bucket.website.arn}/*"
        ]
      },
      # CloudFront - invalidate cache
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation"
        ]
        Resource = aws_cloudfront_distribution.website.arn
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# CodeBuild Project - React App Builder
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "react_builder" {
  name         = "${local.name_prefix}-react-builder"
  description  = "Builds React web app and deploys to S3/CloudFront"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 15 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/react-source/${local.react_content_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-react.yml.tpl", {
      config_bucket   = aws_s3_bucket.build_context.id
      config_key      = "config/aws-exports-${local.config_hash}.json"
      website_bucket  = aws_s3_bucket.website.id
      distribution_id = aws_cloudfront_distribution.website.id
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type         = "LINUX_CONTAINER"

    environment_variable {
      name  = "REACT_SOURCE_HASH"
      value = local.react_content_tag
    }

    environment_variable {
      name  = "CONFIG_HASH"
      value = local.config_hash
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-react-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-react-builder"
  }
}

# -----------------------------------------------------------------------------
# Trigger: Build React App
# Triggers when source OR config changes
# -----------------------------------------------------------------------------

resource "null_resource" "build_react_app_codebuild" {
  triggers = {
    source_hash = local.react_content_tag
    config_hash = local.config_hash
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for React app (source: ${local.react_content_tag}, config: ${local.config_hash})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.react_builder.name}" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ React app build and deployment succeeded!"
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
    aws_codebuild_project.react_builder,
    aws_s3_object.react_source,
    aws_s3_object.aws_exports,
    aws_s3_bucket.website,
    aws_cloudfront_distribution.website
  ]
}
