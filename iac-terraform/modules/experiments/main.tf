/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - Batch Infrastructure & VPC

Architecture: AppSync → Resolver Lambda → AWS Batch (Fargate) → DynamoDB/S3

Creates:
- VPC with private subnets + NAT (or uses existing VPC via vpc_id)
- VPC Flow Logs to CloudWatch
- AWS Batch Fargate compute environment
- AWS Batch job queue and job definition
- ECR repository for experiment container image
- Lambda resolver and AppSync resolvers
- CloudWatch log groups
*/

locals {
  name_prefix      = lower(var.prefix)
  functions_dir    = "${path.module}/../../../src/api/functions"
  docker_dir       = "${path.module}/../../../src/experiments-batch/docker"
  use_existing_vpc = var.vpc_id != null
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# VPC (only when no existing VPC is provided)
# -----------------------------------------------------------------------------

resource "aws_vpc" "batch" {
  # checkov:skip=CKV2_AWS_11:VPC Flow Logs are enabled below
  count      = local.use_existing_vpc ? 0 : 1
  cidr_block = "10.0.0.0/16"

  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-vpc"
  })
}

# Private subnets (2 AZs)
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "private" {
  count             = local.use_existing_vpc ? 0 : 2
  vpc_id            = aws_vpc.batch[0].id
  cidr_block        = cidrsubnet(aws_vpc.batch[0].cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-private-${count.index}"
  })
}

# Public subnet for NAT gateway
resource "aws_subnet" "public" {
  count             = local.use_existing_vpc ? 0 : 1
  vpc_id            = aws_vpc.batch[0].id
  cidr_block        = cidrsubnet(aws_vpc.batch[0].cidr_block, 8, 100)
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-public"
  })
}

# Internet Gateway
resource "aws_internet_gateway" "batch" {
  count  = local.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.batch[0].id

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-igw"
  })
}

# Public route table
resource "aws_route_table" "public" {
  count  = local.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.batch[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.batch[0].id
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count          = local.use_existing_vpc ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

# NAT Gateway (single, for cost savings)
resource "aws_eip" "nat" {
  # checkov:skip=CKV2_AWS_19:EIP is attached to NAT Gateway
  count  = local.use_existing_vpc ? 0 : 1
  domain = "vpc"

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-nat-eip"
  })
}

resource "aws_nat_gateway" "batch" {
  count         = local.use_existing_vpc ? 0 : 1
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-nat"
  })

  depends_on = [aws_internet_gateway.batch]
}

# Private route table
resource "aws_route_table" "private" {
  count  = local.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.batch[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.batch[0].id
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-private-rt"
  })
}

resource "aws_route_table_association" "private" {
  count          = local.use_existing_vpc ? 0 : 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# VPC Flow Logs
resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  count             = local.use_existing_vpc ? 0 : 1
  name              = "/aws/vpc/${local.name_prefix}-experiments-flow-logs"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-flow-logs"
  })
}

resource "aws_iam_role" "flow_log" {
  count = local.use_existing_vpc ? 0 : 1
  name  = "${local.name_prefix}-experiments-flow-log-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.name_prefix}-experiments-flow-log-role" })
}

resource "aws_iam_role_policy" "flow_log" {
  count = local.use_existing_vpc ? 0 : 1
  name  = "${local.name_prefix}-experiments-flow-log-policy"
  role  = aws_iam_role.flow_log[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ]
      Resource = "${aws_cloudwatch_log_group.vpc_flow_logs[0].arn}:*"
    }]
  })
}

resource "aws_flow_log" "batch" {
  count                    = local.use_existing_vpc ? 0 : 1
  iam_role_arn             = aws_iam_role.flow_log[0].arn
  log_destination          = aws_cloudwatch_log_group.vpc_flow_logs[0].arn
  traffic_type             = "ALL"
  vpc_id                   = aws_vpc.batch[0].id
  max_aggregation_interval = 60

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-flow-log"
  })
}

# Look up existing VPC subnets when using an existing VPC
data "aws_subnets" "existing_private" {
  count = local.use_existing_vpc ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["false"]
  }
}

# Resolve subnets for Batch compute environment
locals {
  batch_subnets = (
    local.use_existing_vpc
    ? try(data.aws_subnets.existing_private[0].ids, [])
    : aws_subnet.private[*].id
  )
  resolved_vpc_id = local.use_existing_vpc ? var.vpc_id : aws_vpc.batch[0].id
}

# -----------------------------------------------------------------------------
# AWS Batch Infrastructure
# -----------------------------------------------------------------------------

# Security group for Batch compute environment
resource "aws_security_group" "batch" {
  # checkov:skip=CKV2_AWS_5:Security group is attached to Batch compute environment
  name        = "${local.name_prefix}-experiments-batch-sg"
  description = "Security group for experiments Batch compute environment"
  vpc_id      = local.resolved_vpc_id

  egress {
    description = "Allow all outbound traffic for Fargate tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-batch-sg"
  })
}

# Batch Compute Environment (Fargate)
# Uses the AWS Batch service-linked role (AWSServiceRoleForBatch) automatically,
# matching CDK's FargateComputeEnvironment behavior.
resource "aws_batch_compute_environment" "experiments" {
  name  = "${local.name_prefix}-experiments-compute"
  type  = "MANAGED"
  state = "ENABLED"

  compute_resources {
    type      = "FARGATE"
    max_vcpus = 4

    subnets            = local.batch_subnets
    security_group_ids = [aws_security_group.batch.id]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-compute"
  })

}

# Batch Job Queue
resource "aws_batch_job_queue" "experiments" {
  name     = "${local.name_prefix}-experiments-queue"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.experiments.arn
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-queue"
  })
}

# Batch Job Log Group
resource "aws_cloudwatch_log_group" "batch_job" {
  name              = "/aws/batch/${local.name_prefix}-experiments"
  retention_in_days = 7
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-batch-logs"
  })
}

# Batch Job Definition (Fargate)
resource "aws_batch_job_definition" "experiments" {
  name = "${local.name_prefix}-experiments-job"
  type = "container"

  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image = "${aws_ecr_repository.experiments.repository_url}:${local.experiments_content_tag}"

    resourceRequirements = [
      { type = "VCPU", value = "1" },
      { type = "MEMORY", value = "2048" }
    ]

    jobRoleArn       = aws_iam_role.batch_job.arn
    executionRoleArn = aws_iam_role.batch_execution.arn

    runtimePlatform = {
      cpuArchitecture       = "ARM64"
      operatingSystemFamily = "LINUX"
    }

    environment = [
      { name = "EXPERIMENTS_TABLE_NAME", value = var.experiments_table_name },
      { name = "EXPERIMENTS_BUCKET_NAME", value = var.evaluations_bucket_name },
      { name = "EXPERIMENTS_S3_PREFIX", value = "experiments/generated-cases" },
      { name = "AWS_REGION", value = data.aws_region.current.id }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.batch_job.name
        "awslogs-region"        = data.aws_region.current.id
        "awslogs-stream-prefix" = "experiment"
      }
    }

    networkConfiguration = {
      assignPublicIp = "DISABLED"
    }

    fargatePlatformConfiguration = {
      platformVersion = "LATEST"
    }
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-job"
  })
}

# ECR Repository for Batch container image
resource "aws_ecr_repository" "experiments" {
  # checkov:skip=CKV_AWS_136:Immutable tags not needed for dev containers
  name                 = "${local.name_prefix}-experiments-batch"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-experiments-batch"
  })
}

# Docker image build is handled by CodeBuild (see codebuild.tf)
