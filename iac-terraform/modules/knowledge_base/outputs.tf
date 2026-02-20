# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Outputs for Knowledge Base Module - Native Terraform
# -------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Knowledge Base Outputs
# -----------------------------------------------------------------------------

output "knowledge_base_id" {
  description = "ID of the Bedrock Knowledge Base"
  value       = var.enabled ? aws_bedrockagent_knowledge_base.main[0].id : null
}

output "knowledge_base_arn" {
  description = "ARN of the Bedrock Knowledge Base"
  value       = var.enabled ? aws_bedrockagent_knowledge_base.main[0].arn : null
}

output "data_source_id" {
  description = "ID of the S3 Data Source"
  value       = var.enabled ? aws_bedrockagent_data_source.s3[0].data_source_id : null
}

# -----------------------------------------------------------------------------
# OpenSearch Serverless Outputs
# -----------------------------------------------------------------------------

output "collection_arn" {
  description = "ARN of the OpenSearch Serverless collection"
  value       = var.enabled ? aws_opensearchserverless_collection.vector[0].arn : null
}

output "collection_endpoint" {
  description = "Endpoint of the OpenSearch Serverless collection"
  value       = var.enabled ? aws_opensearchserverless_collection.vector[0].collection_endpoint : null
}

output "collection_name" {
  description = "Name of the OpenSearch Serverless collection"
  value       = var.enabled ? aws_opensearchserverless_collection.vector[0].name : null
}

output "collection_id" {
  description = "ID of the OpenSearch Serverless collection"
  value       = var.enabled ? aws_opensearchserverless_collection.vector[0].id : null
}

# -----------------------------------------------------------------------------
# IAM Outputs
# -----------------------------------------------------------------------------

output "kb_role_arn" {
  description = "ARN of the Knowledge Base IAM role"
  value       = var.enabled ? aws_iam_role.kb_role[0].arn : null
}

# -----------------------------------------------------------------------------
# DynamoDB Outputs
# -----------------------------------------------------------------------------

output "kb_inventory_table_name" {
  description = "Name of the KB inventory DynamoDB table"
  value       = var.enabled ? aws_dynamodb_table.kb_inventory[0].name : null
}

output "kb_inventory_table_arn" {
  description = "ARN of the KB inventory DynamoDB table"
  value       = var.enabled ? aws_dynamodb_table.kb_inventory[0].arn : null
}

# -----------------------------------------------------------------------------
# SQS Outputs
# -----------------------------------------------------------------------------

output "sync_queue_arn" {
  description = "ARN of the sync SQS queue"
  value       = var.enabled ? aws_sqs_queue.sync[0].arn : null
}

output "sync_queue_url" {
  description = "URL of the sync SQS queue"
  value       = var.enabled ? aws_sqs_queue.sync[0].url : null
}

# -----------------------------------------------------------------------------
# Lambda Outputs
# -----------------------------------------------------------------------------

output "sync_lambda_arn" {
  description = "ARN of the sync Lambda function"
  value       = var.enabled ? aws_lambda_function.sync_kb[0].arn : null
}

output "sync_lambda_name" {
  description = "Name of the sync Lambda function"
  value       = var.enabled ? aws_lambda_function.sync_kb[0].function_name : null
}

# -----------------------------------------------------------------------------
# EventBridge Outputs
# -----------------------------------------------------------------------------

output "s3_event_rule_name" {
  description = "Name of the S3 data source EventBridge rule"
  value       = var.enabled ? aws_cloudwatch_event_rule.s3_data_source[0].name : null
}

output "s3_event_rule_arn" {
  description = "ARN of the S3 data source EventBridge rule"
  value       = var.enabled ? aws_cloudwatch_event_rule.s3_data_source[0].arn : null
}
