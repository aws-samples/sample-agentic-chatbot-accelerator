/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - Main Resources

Creates:
- S3 buckets for website hosting and logs
- CloudFront distribution with OAC
- React app build and deployment

Equivalent to: iac-cdk/lib/user-interface/index.ts UserInterface construct
*/

locals {
  name_prefix    = lower(var.prefix)
  react_app_path = "${path.module}/../../../src/user-interface/react-app"
  build_path     = "${local.react_app_path}/dist"
}

# Get current region and account
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
