/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
API Tables Module - Input Variables
*/

variable "prefix" {
  description = "Prefix for resource names (e.g., 'dev-aca')"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the KMS key for DynamoDB encryption"
  type        = string
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
