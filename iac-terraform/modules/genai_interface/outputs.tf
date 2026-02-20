/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Outputs
*/

# -----------------------------------------------------------------------------
# Invoke AgentCore Runtime Lambda
# -----------------------------------------------------------------------------

output "invoke_agent_runtime_function_arn" {
  description = "ARN of the invoke-agentCoreRuntime Lambda function"
  value       = aws_lambda_function.invoke_agent_runtime.arn
}

output "invoke_agent_runtime_function_name" {
  description = "Name of the invoke-agentCoreRuntime Lambda function"
  value       = aws_lambda_function.invoke_agent_runtime.function_name
}

output "invoke_agent_runtime_role_arn" {
  description = "ARN of the invoke-agentCoreRuntime Lambda IAM role"
  value       = aws_iam_role.invoke_agent_runtime.arn
}

# -----------------------------------------------------------------------------
# Agent Tools Handler Lambda
# -----------------------------------------------------------------------------

output "agent_tools_handler_function_arn" {
  description = "ARN of the agent-tools-handler Lambda function"
  value       = aws_lambda_function.agent_tools_handler.arn
}

output "agent_tools_handler_function_name" {
  description = "Name of the agent-tools-handler Lambda function"
  value       = aws_lambda_function.agent_tools_handler.function_name
}

output "agent_tools_handler_role_arn" {
  description = "ARN of the agent-tools-handler Lambda IAM role"
  value       = aws_iam_role.agent_tools_handler.arn
}
