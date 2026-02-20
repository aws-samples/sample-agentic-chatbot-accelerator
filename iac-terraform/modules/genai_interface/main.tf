/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Main Resources

Creates:
- invoke-agentCoreRuntime Lambda (handles AgentCore invocation via SNS)
- agent-tools-handler Lambda (processes agent tools messages)

Equivalent to: lib/genai-interface/index.ts GenAIInterface construct
*/

locals {
  name_prefix   = lower(var.prefix)
  functions_dir = "${path.module}/../../../lib/genai-interface/functions"

  # Build IAM condition for AgentCore resource scoping (matches CDK getTagConditions)
  # Restricts Lambda to only invoke AgentCore runtimes with matching tags
  agentcore_tag_conditions = var.environment_tag != "" ? {
    "aws:ResourceTag/Stack"       = var.stack_tag
    "aws:ResourceTag/Environment" = var.environment_tag
    } : {
    "aws:ResourceTag/Stack" = var.stack_tag
  }
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Shared IAM assume role policy for Lambda
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
