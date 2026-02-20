/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

variable "prefix" {
  description = "Prefix string used for naming AWS resources. Will be lowercased for resource naming."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*$", var.prefix))
    error_message = "Prefix must start with a letter and contain only alphanumeric characters and hyphens."
  }
}
