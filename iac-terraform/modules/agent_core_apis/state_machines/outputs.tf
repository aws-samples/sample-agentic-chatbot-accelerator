/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Agent Core APIs - State Machines Sub-module - Outputs
*/

# -----------------------------------------------------------------------------
# Step Function State Machine ARNs
# -----------------------------------------------------------------------------

output "delete_endpoints_state_machine_arn" {
  description = "ARN of the delete endpoints Step Function"
  value       = aws_sfn_state_machine.delete_endpoints.arn
}

output "delete_endpoints_state_machine_name" {
  description = "Name of the delete endpoints Step Function"
  value       = aws_sfn_state_machine.delete_endpoints.name
}

output "delete_runtime_state_machine_arn" {
  description = "ARN of the delete runtime Step Function"
  value       = aws_sfn_state_machine.delete_runtime.arn
}

output "delete_runtime_state_machine_name" {
  description = "Name of the delete runtime Step Function"
  value       = aws_sfn_state_machine.delete_runtime.name
}

output "create_runtime_state_machine_arn" {
  description = "ARN of the create runtime Step Function"
  value       = aws_sfn_state_machine.create_runtime.arn
}

output "create_runtime_state_machine_name" {
  description = "Name of the create runtime Step Function"
  value       = aws_sfn_state_machine.create_runtime.name
}

# -----------------------------------------------------------------------------
# IAM Role
# -----------------------------------------------------------------------------

output "step_functions_role_arn" {
  description = "ARN of the Step Functions IAM role"
  value       = aws_iam_role.step_functions.arn
}
