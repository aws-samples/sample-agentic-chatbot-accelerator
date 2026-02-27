/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Shared module for Lambda utilities

Provides:
- AWS Lambda Powertools layer (public AWS layer)
- Boto3 layer (custom, pre-built)
- GenAI Core layer (custom, pre-built)
- Default environment variables for Lambda functions
*/

locals {
  # Lowercase prefix for resource naming (matches CDK generatePrefix behavior)
  name_prefix = lower(var.prefix)

  # Python runtime without dots for layer ARN construction
  python_version_nodot = replace(var.python_runtime, ".", "")

  # Build directory path
  build_path = "${path.module}/${var.build_dir}"
}

# Get current AWS partition (aws, aws-cn, aws-us-gov)
data "aws_partition" "current" {}

# Get current AWS region
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# AWS Lambda Powertools Layer (Public AWS Layer)
# No build required - reference by ARN
# https://docs.powertools.aws.dev/lambda/python/latest/
# -----------------------------------------------------------------------------
locals {
  # Construct Powertools layer ARN based on architecture
  powertools_layer_arn = join("", [
    "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.id}:",
    "017000801446:layer:AWSLambdaPowertoolsPythonV3-${local.python_version_nodot}-",
    var.lambda_architecture == "x86_64" ? "x86_64" : "arm64",
    ":${var.powertools_layer_version}"
  ])
}

# -----------------------------------------------------------------------------
# Boto3 Layer (Built by CodeBuild)
# Contains latest boto3/botocore for access to newest AWS service features
# Built automatically by CodeBuild when requirements.txt changes
# See: codebuild-layers.tf
# -----------------------------------------------------------------------------
resource "aws_lambda_layer_version" "boto3" {
  s3_bucket                = aws_s3_bucket.layer_builds.id
  s3_key                   = "boto3-layer/output/${local.boto3_content_tag}/layer.zip"
  layer_name               = "${local.name_prefix}-boto3-layer"
  description              = "Latest boto3/botocore for ${var.prefix}"
  compatible_runtimes      = [var.python_runtime]
  compatible_architectures = [var.lambda_architecture]

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [null_resource.build_boto3_layer]
}

# -----------------------------------------------------------------------------
# GenAI Core Layer (Built by Terraform archive_file)
# Shared Python SDK with utilities for:
# - OpenSearch Serverless (aoss)
# - API helpers (auth, sessions, message handling)
# - Data operations (DynamoDB, S3)
# - Processing utilities
# No Docker required — pure Python, built directly by Terraform
# See: codebuild-layers.tf for archive_file data source
# -----------------------------------------------------------------------------
resource "aws_lambda_layer_version" "genai_core" {
  filename                 = data.archive_file.genai_core_layer.output_path
  source_code_hash         = data.archive_file.genai_core_layer.output_base64sha256
  layer_name               = "${local.name_prefix}-genai-core-layer"
  description              = "GenAI Core shared library for ${var.prefix}"
  compatible_runtimes      = [var.python_runtime]
  compatible_architectures = [var.lambda_architecture]

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Default Environment Variables for Lambda Functions
# Matches CDK: this.defaultEnvironmentVariables
# -----------------------------------------------------------------------------
locals {
  default_environment_variables = {
    POWERTOOLS_DEV              = "false"
    LOG_LEVEL                   = "INFO"
    POWERTOOLS_LOGGER_LOG_EVENT = "true"
    POWERTOOLS_SERVICE_NAME     = "aca"
  }
}
