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
# Boto3 Layer (Custom Layer - Pre-built)
# Contains latest boto3/botocore for access to newest AWS service features
# Build with: ./scripts/build-layers.sh
# -----------------------------------------------------------------------------
resource "aws_lambda_layer_version" "boto3" {
  filename                 = "${local.build_path}/boto3-layer.zip"
  source_code_hash         = filebase64sha256("${local.build_path}/boto3-layer.zip")
  layer_name               = "${local.name_prefix}-boto3-layer"
  description              = "Latest boto3/botocore for ${var.prefix}"
  compatible_runtimes      = [var.python_runtime]
  compatible_architectures = [var.lambda_architecture]

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# GenAI Core Layer (Custom Layer - Pre-built)
# Shared Python SDK with utilities for:
# - OpenSearch Serverless (aoss)
# - API helpers (auth, sessions, message handling)
# - Data operations (DynamoDB, S3)
# - Processing utilities
# Build with: ./scripts/build-layers.sh
# -----------------------------------------------------------------------------
resource "aws_lambda_layer_version" "genai_core" {
  filename                 = "${local.build_path}/genai-core-layer.zip"
  source_code_hash         = filebase64sha256("${local.build_path}/genai-core-layer.zip")
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
