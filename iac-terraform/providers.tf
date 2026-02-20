/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project       = "agentic-chatbot-accelerator"
      ManagedBy     = "terraform"
      Stack         = var.prefix
      Environment   = var.environment
      SolutionsCode = "uksb-enc2nrtqd0"
    }
  }
}

# AWSCC provider for resources not yet available in AWS provider
# Used by: observability module (awscc_xray_transaction_search_config)
provider "awscc" {
  region  = var.aws_region
  profile = var.aws_profile
}
