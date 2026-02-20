/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
AgentCore Module - ECR Repository

Creates:
- ECR repository for agent runtime container images
- Lifecycle policy for image management
*/

# -----------------------------------------------------------------------------
# ECR Repository for Agent Runtime Container
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "agent_core" {
  # checkov:skip=CKV_AWS_51:Mutable tags required for iterative development with "latest" tag
  name                 = "${local.name_prefix}-agent-core"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # Allow deletion even with images present

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = {
    Name = "${local.name_prefix}-agent-core"
  }
}

# Lifecycle policy to limit the number of untagged images
resource "aws_ecr_lifecycle_policy" "agent_core" {
  repository = aws_ecr_repository.agent_core.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Local for container URI with content-hash-based tagging
# -----------------------------------------------------------------------------

locals {
  docker_dir = "${path.module}/../../../lib/agent-core/docker"

  # Compute hash of Docker source files to detect changes
  # When any file in the Docker build context changes, the hash changes,
  # which changes the image tag, which triggers Terraform to create a new runtime version
  docker_source_hash = sha256(join("", [
    filesha256("${local.docker_dir}/Dockerfile"),
    filesha256("${local.docker_dir}/requirements.txt"),
    filesha256("${local.docker_dir}/app.py"),
    sha256(join("", [for f in sort(fileset("${local.docker_dir}/src", "**")) : filesha256("${local.docker_dir}/src/${f}")]))
  ]))

  # Use first 12 chars of hash as image tag (enough for uniqueness)
  content_based_tag = substr(local.docker_source_hash, 0, 12)

  # Use provided ECR image URI, or construct from repository with content-based tag
  container_uri = var.ecr_image_uri != null ? var.ecr_image_uri : "${aws_ecr_repository.agent_core.repository_url}:${local.content_based_tag}"
}
