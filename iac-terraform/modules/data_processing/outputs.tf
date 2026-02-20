# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Outputs for Data Processing Module
# -------------------------------------------------------------------------

# S3 Buckets
output "data_bucket_id" {
  description = "ID of the data S3 bucket"
  value       = aws_s3_bucket.data.id
}

output "data_bucket_arn" {
  description = "ARN of the data S3 bucket"
  value       = aws_s3_bucket.data.arn
}

output "data_bucket_name" {
  description = "Name of the data S3 bucket"
  value       = aws_s3_bucket.data.bucket
}

output "logging_bucket_id" {
  description = "ID of the logging S3 bucket"
  value       = aws_s3_bucket.logging.id
}

output "logging_bucket_arn" {
  description = "ARN of the logging S3 bucket"
  value       = aws_s3_bucket.logging.arn
}

# DynamoDB Table
output "document_state_table_name" {
  description = "Name of the document state DynamoDB table"
  value       = aws_dynamodb_table.document_state.name
}

output "document_state_table_arn" {
  description = "ARN of the document state DynamoDB table"
  value       = aws_dynamodb_table.document_state.arn
}

# Step Functions State Machine
output "state_machine_arn" {
  description = "ARN of the data processing state machine"
  value       = aws_sfn_state_machine.data_processing.arn
}

output "state_machine_name" {
  description = "Name of the data processing state machine"
  value       = aws_sfn_state_machine.data_processing.name
}

# SQS Queues
output "pipeline_start_queue_arn" {
  description = "ARN of the pipeline start SQS queue"
  value       = aws_sqs_queue.pipeline_start.arn
}

output "pipeline_start_queue_url" {
  description = "URL of the pipeline start SQS queue"
  value       = aws_sqs_queue.pipeline_start.url
}

output "pipeline_start_dlq_arn" {
  description = "ARN of the pipeline start dead letter queue"
  value       = aws_sqs_queue.pipeline_start_dlq.arn
}

# Lambda Functions
output "lambda_pipeline_start_arn" {
  description = "ARN of the pipeline start Lambda function"
  value       = aws_lambda_function.pipeline_start.arn
}

output "lambda_create_metadata_file_arn" {
  description = "ARN of the create metadata file Lambda function"
  value       = aws_lambda_function.create_metadata_file.arn
}

output "lambda_transcribe_read_arn" {
  description = "ARN of the transcribe read Lambda function"
  value       = aws_lambda_function.transcribe_read.arn
}

output "lambda_json_read_arn" {
  description = "ARN of the JSON read Lambda function"
  value       = aws_lambda_function.json_read.arn
}

# EventBridge Rule
output "eventbridge_rule_arn" {
  description = "ARN of the S3 data processing EventBridge rule"
  value       = aws_cloudwatch_event_rule.s3_data_processing.arn
}

output "eventbridge_rule_name" {
  description = "Name of the S3 data processing EventBridge rule"
  value       = aws_cloudwatch_event_rule.s3_data_processing.name
}

# Prefix configurations (useful for consumers of this module)
output "input_prefix" {
  description = "S3 prefix for input files"
  value       = var.input_prefix
}

output "data_source_prefix" {
  description = "S3 prefix for data source files"
  value       = var.data_source_prefix
}

output "processing_prefix" {
  description = "S3 prefix for processing files"
  value       = var.processing_prefix
}
