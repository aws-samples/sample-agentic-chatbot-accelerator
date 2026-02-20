/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

variable "prefix" {
  description = "Prefix string used for naming AWS resources."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*$", var.prefix))
    error_message = "Prefix must start with a letter and contain only alphanumeric characters and hyphens."
  }
}

variable "lambda_architecture" {
  description = "Lambda architecture (x86_64 or arm64). Default is arm64 for better price/performance."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.lambda_architecture)
    error_message = "Lambda architecture must be either 'x86_64' or 'arm64'."
  }
}

variable "python_runtime" {
  description = "Python runtime version for Lambda functions."
  type        = string
  default     = "python3.14"

  validation {
    condition     = can(regex("^python3\\.[0-9]+$", var.python_runtime))
    error_message = "Python runtime must be in format 'python3.X'."
  }
}

variable "powertools_layer_version" {
  description = "Version of AWS Lambda Powertools layer to use."
  type        = string
  default     = "27"
}

variable "build_dir" {
  description = "Directory containing pre-built layer zip files. Relative to module path."
  type        = string
  default     = "../../build"
}
