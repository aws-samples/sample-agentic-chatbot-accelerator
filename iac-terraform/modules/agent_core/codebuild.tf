/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AgentCore Module - CodeBuild Image Builder

Replaces the local `build-image.sh` script with AWS CodeBuild.
Docker images are built in the cloud — no local Docker required.

Creates:
- S3 bucket for Docker build context upload
- CodeBuild projects for agent + swarm images
- IAM role for CodeBuild
- null_resources that trigger builds only when source files change
*/

# -----------------------------------------------------------------------------
# S3 Bucket for Docker Build Context
# Holds zipped Docker directories uploaded by Terraform
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "build_context" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for temporary build context
  # checkov:skip=CKV_AWS_18:Access logging not needed for temporary build artifacts
  # checkov:skip=CKV2_AWS_62:Event notifications not needed for build context bucket
  bucket        = "${local.name_prefix}-codebuild-context-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = {
    Name = "${local.name_prefix}-codebuild-context"
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
# Upload Docker Build Contexts to S3
# Uses archive_file + aws_s3_object so Terraform tracks the content hash
# and only re-uploads when source files change.
# -----------------------------------------------------------------------------

data "archive_file" "agent_docker_context" {
  type        = "zip"
  source_dir  = local.agent_core_dir
  output_path = "${path.module}/../../../iac-terraform/build/.agent-docker-context.zip"
  excludes    = [".git", "__pycache__", "*.pyc", "functions"]
}

resource "aws_s3_object" "agent_docker_context" {
  bucket = aws_s3_bucket.build_context.id
  key    = "agent-core/${local.content_based_tag}.zip"
  source = data.archive_file.agent_docker_context.output_path
  etag   = data.archive_file.agent_docker_context.output_md5

  depends_on = [data.archive_file.agent_docker_context]
}

data "archive_file" "swarm_docker_context" {
  type        = "zip"
  source_dir  = local.agent_core_dir
  output_path = "${path.module}/../../../iac-terraform/build/.swarm-docker-context.zip"
  excludes    = [".git", "__pycache__", "*.pyc", "functions"]
}

resource "aws_s3_object" "swarm_docker_context" {
  bucket = aws_s3_bucket.build_context.id
  key    = "swarm-agent-core/${local.swarm_content_based_tag}.zip"
  source = data.archive_file.swarm_docker_context.output_path
  etag   = data.archive_file.swarm_docker_context.output_md5

  depends_on = [data.archive_file.swarm_docker_context]
}

data "archive_file" "graph_docker_context" {
  type        = "zip"
  source_dir  = local.agent_core_dir
  output_path = "${path.module}/../../../iac-terraform/build/.graph-docker-context.zip"
  excludes    = [".git", "__pycache__", "*.pyc", "functions"]
}

resource "aws_s3_object" "graph_docker_context" {
  bucket = aws_s3_bucket.build_context.id
  key    = "graph-agent-core/${local.graph_content_based_tag}.zip"
  source = data.archive_file.graph_docker_context.output_path
  etag   = data.archive_file.graph_docker_context.output_md5

  depends_on = [data.archive_file.graph_docker_context]
}

data "archive_file" "agents_as_tools_docker_context" {
  type        = "zip"
  source_dir  = local.agent_core_dir
  output_path = "${path.module}/../../../iac-terraform/build/.agents-as-tools-docker-context.zip"
  excludes    = [".git", "__pycache__", "*.pyc", "functions"]
}

resource "aws_s3_object" "agents_as_tools_docker_context" {
  bucket = aws_s3_bucket.build_context.id
  key    = "agents-as-tools-agent-core/${local.agents_as_tools_content_based_tag}.zip"
  source = data.archive_file.agents_as_tools_docker_context.output_path
  etag   = data.archive_file.agents_as_tools_docker_context.output_md5

  depends_on = [data.archive_file.agents_as_tools_docker_context]
}

# -----------------------------------------------------------------------------
# IAM Role for CodeBuild
# Permissions: ECR push, S3 read, CloudWatch Logs, KMS
# -----------------------------------------------------------------------------

resource "aws_iam_role" "codebuild" {
  name = "${local.name_prefix}-codebuild-image-builder"

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
    Name = "${local.name_prefix}-codebuild-image-builder"
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${local.name_prefix}-codebuild-image-builder-policy"
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
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
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
        Resource = [
          aws_ecr_repository.agent_core.arn,
          aws_ecr_repository.swarm_agent_core.arn,
          aws_ecr_repository.graph_agent_core.arn,
          aws_ecr_repository.agents_as_tools_agent_core.arn
        ]
      },
      # KMS — decrypt S3 objects
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
# CodeBuild Project — Standard Agent Image
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "agent_image_builder" {
  # checkov:skip=CKV_AWS_316:Privileged mode required for Docker-in-Docker builds
  name         = "${local.name_prefix}-agent-image-builder"
  description  = "Builds and pushes the AgentCore Docker image to ECR"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 30 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/agent-core/${local.content_based_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-image.yml.tpl", {
      ecr_repo_url    = aws_ecr_repository.agent_core.repository_url
      aws_region      = data.aws_region.current.id
      account_id      = data.aws_caller_identity.current.account_id
      dockerfile_path = "docker/Dockerfile"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.shared.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.shared.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.shared.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = true # Required for Docker builds

    environment_variable {
      name  = "IMAGE_TAG"
      value = local.content_based_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-agent-image-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-agent-image-builder"
  }
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Swarm Agent Image
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "swarm_image_builder" {
  # checkov:skip=CKV_AWS_316:Privileged mode required for Docker-in-Docker builds
  name         = "${local.name_prefix}-swarm-image-builder"
  description  = "Builds and pushes the Swarm AgentCore Docker image to ECR"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 30 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/swarm-agent-core/${local.swarm_content_based_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-image.yml.tpl", {
      ecr_repo_url    = aws_ecr_repository.swarm_agent_core.repository_url
      aws_region      = data.aws_region.current.id
      account_id      = data.aws_caller_identity.current.account_id
      dockerfile_path = "docker-swarm/Dockerfile"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.shared.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.shared.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.shared.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "IMAGE_TAG"
      value = local.swarm_content_based_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-swarm-image-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-swarm-image-builder"
  }
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
# Trigger: Build Standard Agent Image (only when source changes)
# The content_based_tag changes only when Docker source files change.
# When it changes, Terraform recreates this null_resource → starts a build.
# -----------------------------------------------------------------------------

resource "null_resource" "build_agent_image" {
  triggers = {
    source_hash = local.content_based_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      AWS_PROFILE = var.aws_profile
    }
    command = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for agent image (tag: ${local.content_based_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.agent_image_builder.name}" \
        --source-location-override "${aws_s3_bucket.build_context.id}/agent-core/${local.content_based_tag}.zip" \
        --environment-variables-override "name=IMAGE_TAG,value=${local.content_based_tag},type=PLAINTEXT" \
        --query 'build.id' --output text \
        ${var.shared.lambda_architecture == "arm64" ? "" : ""})

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Agent image build succeeded!"
            break
            ;;
          FAILED|FAULT|STOPPED|TIMED_OUT)
            echo "❌ Build failed with status: $STATUS"
            # Print build logs URL for debugging
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
    aws_codebuild_project.agent_image_builder,
    aws_s3_object.agent_docker_context,
    aws_ecr_repository.agent_core,
    time_sleep.wait_for_iam_propagation
  ]
}

# -----------------------------------------------------------------------------
# Trigger: Build Swarm Agent Image (only when source changes)
# -----------------------------------------------------------------------------

resource "null_resource" "build_swarm_image" {
  triggers = {
    source_hash = local.swarm_content_based_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      AWS_PROFILE = var.aws_profile
    }
    command = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for swarm agent image (tag: ${local.swarm_content_based_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.swarm_image_builder.name}" \
        --source-location-override "${aws_s3_bucket.build_context.id}/swarm-agent-core/${local.swarm_content_based_tag}.zip" \
        --environment-variables-override "name=IMAGE_TAG,value=${local.swarm_content_based_tag},type=PLAINTEXT" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Swarm agent image build succeeded!"
            break
            ;;
          FAILED|FAULT|STOPPED|TIMED_OUT)
            echo "❌ Swarm build failed with status: $STATUS"
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
    aws_codebuild_project.swarm_image_builder,
    aws_s3_object.swarm_docker_context,
    aws_ecr_repository.swarm_agent_core,
    time_sleep.wait_for_iam_propagation
  ]
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Graph Agent Image
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "graph_image_builder" {
  # checkov:skip=CKV_AWS_316:Privileged mode required for Docker-in-Docker builds
  name         = "${local.name_prefix}-graph-image-builder"
  description  = "Builds and pushes the Graph AgentCore Docker image to ECR"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 30 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/graph-agent-core/${local.graph_content_based_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-image.yml.tpl", {
      ecr_repo_url    = aws_ecr_repository.graph_agent_core.repository_url
      aws_region      = data.aws_region.current.id
      account_id      = data.aws_caller_identity.current.account_id
      dockerfile_path = "docker-graph/Dockerfile"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.shared.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.shared.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.shared.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "IMAGE_TAG"
      value = local.graph_content_based_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-graph-image-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-graph-image-builder"
  }
}

# -----------------------------------------------------------------------------
# Trigger: Build Graph Agent Image (only when source changes)
# -----------------------------------------------------------------------------

resource "null_resource" "build_graph_image" {
  triggers = {
    source_hash = local.graph_content_based_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      AWS_PROFILE = var.aws_profile
    }
    command = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for graph agent image (tag: ${local.graph_content_based_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.graph_image_builder.name}" \
        --source-location-override "${aws_s3_bucket.build_context.id}/graph-agent-core/${local.graph_content_based_tag}.zip" \
        --environment-variables-override "name=IMAGE_TAG,value=${local.graph_content_based_tag},type=PLAINTEXT" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Graph agent image build succeeded!"
            break
            ;;
          FAILED|FAULT|STOPPED|TIMED_OUT)
            echo "❌ Graph build failed with status: $STATUS"
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
    aws_codebuild_project.graph_image_builder,
    aws_s3_object.graph_docker_context,
    aws_ecr_repository.graph_agent_core,
    time_sleep.wait_for_iam_propagation
  ]
}

# -----------------------------------------------------------------------------
# CodeBuild Project — Agents-as-Tools Agent Image
# -----------------------------------------------------------------------------

resource "aws_codebuild_project" "agents_as_tools_image_builder" {
  # checkov:skip=CKV_AWS_316:Privileged mode required for Docker-in-Docker builds
  name         = "${local.name_prefix}-agents-as-tools-image-builder"
  description  = "Builds and pushes the Agents-as-Tools AgentCore Docker image to ECR"
  service_role = aws_iam_role.codebuild.arn

  build_timeout = 30 # minutes

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_context.id}/agents-as-tools-agent-core/${local.agents_as_tools_content_based_tag}.zip"

    buildspec = templatefile("${path.module}/buildspec-image.yml.tpl", {
      ecr_repo_url    = aws_ecr_repository.agents_as_tools_agent_core.repository_url
      aws_region      = data.aws_region.current.id
      account_id      = data.aws_caller_identity.current.account_id
      dockerfile_path = "docker-agents-as-tools/Dockerfile"
    })
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = var.shared.lambda_architecture == "arm64" ? "BUILD_GENERAL1_SMALL" : "BUILD_GENERAL1_SMALL"
    image           = var.shared.lambda_architecture == "arm64" ? "aws/codebuild/amazonlinux-aarch64-standard:3.0" : "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type            = var.shared.lambda_architecture == "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "IMAGE_TAG"
      value = local.agents_as_tools_content_based_tag
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-agents-as-tools-image-builder"
    }
  }

  tags = {
    Name = "${local.name_prefix}-agents-as-tools-image-builder"
  }
}

# -----------------------------------------------------------------------------
# Trigger: Build Agents-as-Tools Agent Image (only when source changes)
# -----------------------------------------------------------------------------

resource "null_resource" "build_agents_as_tools_image" {
  triggers = {
    source_hash = local.agents_as_tools_content_based_tag
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      AWS_PROFILE = var.aws_profile
    }
    command = <<-EOT
      set -euo pipefail

      echo "Starting CodeBuild for agents-as-tools agent image (tag: ${local.agents_as_tools_content_based_tag})..."

      BUILD_ID=$(aws codebuild start-build \
        --project-name "${aws_codebuild_project.agents_as_tools_image_builder.name}" \
        --source-location-override "${aws_s3_bucket.build_context.id}/agents-as-tools-agent-core/${local.agents_as_tools_content_based_tag}.zip" \
        --environment-variables-override "name=IMAGE_TAG,value=${local.agents_as_tools_content_based_tag},type=PLAINTEXT" \
        --query 'build.id' --output text)

      echo "Build started: $BUILD_ID"
      echo "Waiting for build to complete..."

      while true; do
        STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' --output text)
        case "$STATUS" in
          SUCCEEDED)
            echo "✅ Agents-as-tools agent image build succeeded!"
            break
            ;;
          FAILED|FAULT|STOPPED|TIMED_OUT)
            echo "❌ Agents-as-tools build failed with status: $STATUS"
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
    aws_codebuild_project.agents_as_tools_image_builder,
    aws_s3_object.agents_as_tools_docker_context,
    aws_ecr_repository.agents_as_tools_agent_core,
    time_sleep.wait_for_iam_propagation
  ]
}
