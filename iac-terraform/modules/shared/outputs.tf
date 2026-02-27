/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# Layer ARNs
# These are used when creating Lambda functions
# -----------------------------------------------------------------------------

output "powertools_layer_arn" {
  description = "ARN of the AWS Lambda Powertools layer (public AWS layer)"
  value       = local.powertools_layer_arn
}

output "boto3_layer_arn" {
  description = "ARN of the custom boto3/botocore layer"
  value       = aws_lambda_layer_version.boto3.arn
}

output "genai_core_layer_arn" {
  description = "ARN of the GenAI Core shared library layer"
  value       = aws_lambda_layer_version.genai_core.arn
}

# Convenience output for all layer ARNs
output "all_layer_arns" {
  description = "List of all layer ARNs for Lambda functions"
  value = [
    local.powertools_layer_arn,
    aws_lambda_layer_version.boto3.arn,
    aws_lambda_layer_version.genai_core.arn
  ]
}

# -----------------------------------------------------------------------------
# Lambda Configuration
# These are used to ensure consistency across Lambda functions
# -----------------------------------------------------------------------------

output "python_runtime" {
  description = "Python runtime for Lambda functions"
  value       = var.python_runtime
}

output "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64)"
  value       = var.lambda_architecture
}

output "default_environment_variables" {
  description = "Default environment variables for Lambda functions (Powertools config)"
  value       = local.default_environment_variables
}

# -----------------------------------------------------------------------------
# Layer Version Information (for debugging/reference)
# -----------------------------------------------------------------------------

output "boto3_layer_version" {
  description = "Version number of the boto3 layer"
  value       = aws_lambda_layer_version.boto3.version
}

output "genai_core_layer_version" {
  description = "Version number of the GenAI Core layer"
  value       = aws_lambda_layer_version.genai_core.version
}

# -----------------------------------------------------------------------------
# Pre-built Lambda Artifacts (S3 locations)
# TypeScript Lambdas are built by CodeBuild and stored in S3
# -----------------------------------------------------------------------------

output "notify_runtime_update_s3_bucket" {
  description = "S3 bucket containing the notify-runtime-update Lambda zip"
  value       = aws_s3_bucket.layer_builds.id
}

output "notify_runtime_update_s3_key" {
  description = "S3 key for the notify-runtime-update Lambda zip"
  value       = "notify-runtime-update/output/${local.notify_runtime_update_content_tag}/lambda.zip"
}

output "notify_runtime_update_source_hash" {
  description = "Content hash of the notify-runtime-update Lambda source (for change detection)"
  value       = local.notify_runtime_update_content_tag
}

output "layer_builds_bucket" {
  description = "S3 bucket for layer and Lambda builds"
  value       = aws_s3_bucket.layer_builds.id
}
