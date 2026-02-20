/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Cleanup Module - Outputs
*/

output "cleanup_lambda_arn" {
  description = "ARN of the cleanup Lambda function"
  value       = aws_lambda_function.cleanup.arn
}

output "cleanup_lambda_name" {
  description = "Name of the cleanup Lambda function"
  value       = aws_lambda_function.cleanup.function_name
}

output "cleanup_role_arn" {
  description = "ARN of the cleanup Lambda IAM role"
  value       = aws_iam_role.cleanup.arn
}
