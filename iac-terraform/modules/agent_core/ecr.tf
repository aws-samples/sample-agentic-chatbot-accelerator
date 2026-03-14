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

# Repository policy to allow Bedrock AgentCore service to pull images
resource "aws_ecr_repository_policy" "agent_core" {
  repository = aws_ecr_repository.agent_core.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBedrockAgentCorePull"
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
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
# ECR Repository for Swarm Agent Runtime Container
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "swarm_agent_core" {
  # checkov:skip=CKV_AWS_51:Mutable tags required for iterative development with "latest" tag
  name                 = "${local.name_prefix}-swarm-agent-core"
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
    Name = "${local.name_prefix}-swarm-agent-core"
  }
}

# Repository policy to allow Bedrock AgentCore service to pull images
resource "aws_ecr_repository_policy" "swarm_agent_core" {
  repository = aws_ecr_repository.swarm_agent_core.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBedrockAgentCorePull"
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}

# Lifecycle policy to limit the number of untagged images
resource "aws_ecr_lifecycle_policy" "swarm_agent_core" {
  repository = aws_ecr_repository.swarm_agent_core.name

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
# ECR Repository for Graph Agent Runtime Container
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "graph_agent_core" {
  # checkov:skip=CKV_AWS_51:Mutable tags required for iterative development with "latest" tag
  name                 = "${local.name_prefix}-graph-agent-core"
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
    Name = "${local.name_prefix}-graph-agent-core"
  }
}

# Repository policy to allow Bedrock AgentCore service to pull images
resource "aws_ecr_repository_policy" "graph_agent_core" {
  repository = aws_ecr_repository.graph_agent_core.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBedrockAgentCorePull"
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}

# Lifecycle policy to limit the number of untagged images
resource "aws_ecr_lifecycle_policy" "graph_agent_core" {
  repository = aws_ecr_repository.graph_agent_core.name

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
# ECR Repository for Agents-as-Tools Agent Runtime Container
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "agents_as_tools_agent_core" {
  # checkov:skip=CKV_AWS_51:Mutable tags required for iterative development with "latest" tag
  name                 = "${local.name_prefix}-agents-as-tools-agent-core"
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
    Name = "${local.name_prefix}-agents-as-tools-agent-core"
  }
}

# Repository policy to allow Bedrock AgentCore service to pull images
resource "aws_ecr_repository_policy" "agents_as_tools_agent_core" {
  repository = aws_ecr_repository.agents_as_tools_agent_core.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBedrockAgentCorePull"
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}

# Lifecycle policy to limit the number of untagged images
resource "aws_ecr_lifecycle_policy" "agents_as_tools_agent_core" {
  repository = aws_ecr_repository.agents_as_tools_agent_core.name

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
  # Parent directory containing all Docker build contexts and shared code
  # All Dockerfiles reference paths relative to this dir (e.g., COPY shared/ shared/.)
  agent_core_dir = "${path.module}/../../../src/agent-core"

  docker_dir                 = "${local.agent_core_dir}/docker"
  swarm_docker_dir           = "${local.agent_core_dir}/docker-swarm"
  graph_docker_dir           = "${local.agent_core_dir}/docker-graph"
  agents_as_tools_docker_dir = "${local.agent_core_dir}/docker-agents-as-tools"
  shared_dir                 = "${local.agent_core_dir}/shared"

  # Hash of shared code (included in all container hashes since all Dockerfiles COPY shared/)
  shared_source_hash = sha256(join("", [
    for f in sort(fileset("${local.shared_dir}", "**")) : filesha256("${local.shared_dir}/${f}")
  ]))

  # --- Standard agent container ---
  # Compute hash of Docker source files + shared to detect changes
  docker_source_hash = sha256(join("", [
    filesha256("${local.docker_dir}/Dockerfile"),
    filesha256("${local.docker_dir}/requirements.txt"),
    filesha256("${local.docker_dir}/app.py"),
    sha256(join("", [for f in sort(fileset("${local.docker_dir}/src", "**")) : filesha256("${local.docker_dir}/src/${f}")])),
    local.shared_source_hash,
  ]))

  # Use first 12 chars of hash as image tag (enough for uniqueness)
  content_based_tag = substr(local.docker_source_hash, 0, 12)

  # Use provided ECR image URI, or construct from repository with content-based tag
  container_uri = var.ecr_image_uri != null ? var.ecr_image_uri : "${aws_ecr_repository.agent_core.repository_url}:${local.content_based_tag}"

  # --- Swarm container ---
  swarm_docker_source_hash = sha256(join("", [
    filesha256("${local.swarm_docker_dir}/Dockerfile"),
    filesha256("${local.swarm_docker_dir}/requirements.txt"),
    filesha256("${local.swarm_docker_dir}/app.py"),
    sha256(join("", [for f in sort(fileset("${local.swarm_docker_dir}/src", "**")) : filesha256("${local.swarm_docker_dir}/src/${f}")])),
    local.shared_source_hash,
  ]))

  swarm_content_based_tag = substr(local.swarm_docker_source_hash, 0, 12)

  swarm_container_uri = var.swarm_ecr_image_uri != null ? var.swarm_ecr_image_uri : "${aws_ecr_repository.swarm_agent_core.repository_url}:${local.swarm_content_based_tag}"

  # --- Graph container ---
  graph_docker_source_hash = sha256(join("", [
    filesha256("${local.graph_docker_dir}/Dockerfile"),
    filesha256("${local.graph_docker_dir}/requirements.txt"),
    filesha256("${local.graph_docker_dir}/app.py"),
    sha256(join("", [for f in sort(fileset("${local.graph_docker_dir}/src", "**")) : filesha256("${local.graph_docker_dir}/src/${f}")])),
    local.shared_source_hash,
  ]))

  graph_content_based_tag = substr(local.graph_docker_source_hash, 0, 12)

  graph_container_uri = var.graph_ecr_image_uri != null ? var.graph_ecr_image_uri : "${aws_ecr_repository.graph_agent_core.repository_url}:${local.graph_content_based_tag}"

  # --- Agents-as-Tools container ---
  agents_as_tools_docker_source_hash = sha256(join("", [
    filesha256("${local.agents_as_tools_docker_dir}/Dockerfile"),
    filesha256("${local.agents_as_tools_docker_dir}/requirements.txt"),
    filesha256("${local.agents_as_tools_docker_dir}/app.py"),
    sha256(join("", [for f in sort(fileset("${local.agents_as_tools_docker_dir}/src", "**")) : filesha256("${local.agents_as_tools_docker_dir}/src/${f}")])),
    local.shared_source_hash,
  ]))

  agents_as_tools_content_based_tag = substr(local.agents_as_tools_docker_source_hash, 0, 12)

  agents_as_tools_container_uri = var.agents_as_tools_ecr_image_uri != null ? var.agents_as_tools_ecr_image_uri : "${aws_ecr_repository.agents_as_tools_agent_core.repository_url}:${local.agents_as_tools_content_based_tag}"
}
