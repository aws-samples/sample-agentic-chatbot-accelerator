/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
GenAI Interface Module - Main Resources

Creates:
- agent-tools-handler Lambda (processes agent tools messages)

After the Direct WebSocket migration, this module only contains
the agent-tools-handler Lambda (for AI-rephrased tool descriptions).
The invokeAgentCoreRuntime Lambda was removed — the browser now
communicates directly with AgentCore containers via WebSocket.

Equivalent to: iac-cdk/lib/genai-interface/index.ts GenAIInterface construct
*/

locals {
  name_prefix   = lower(var.prefix)
  functions_dir = "${path.module}/../../../src/genai-interface/functions"
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
