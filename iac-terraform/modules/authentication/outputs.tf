/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# Outputs matching CDK CfnOutput definitions
# -----------------------------------------------------------------------------

output "user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_arn" {
  description = "The ARN of the Cognito User Pool"
  value       = aws_cognito_user_pool.main.arn
}

output "identity_pool_id" {
  description = "The ID of the Cognito Identity Pool"
  value       = aws_cognito_identity_pool.main.id
}

output "user_pool_client_id" {
  description = "The ID of the Cognito User Pool Client"
  value       = aws_cognito_user_pool_client.main.id
}

output "user_pool_link" {
  description = "Direct link to the Cognito User Pool in AWS Console"
  value       = "https://${data.aws_region.current.id}.console.aws.amazon.com/cognito/v2/idp/user-pools/${aws_cognito_user_pool.main.id}/users?region=${data.aws_region.current.id}"
}

# -----------------------------------------------------------------------------
# Additional outputs for use by other modules
# -----------------------------------------------------------------------------

output "user_pool_endpoint" {
  description = "The endpoint of the Cognito User Pool (for OAuth/OIDC)"
  value       = aws_cognito_user_pool.main.endpoint
}

output "authenticated_role_arn" {
  description = "ARN of the IAM role for authenticated users"
  value       = aws_iam_role.authenticated.arn
}

output "authenticated_role_name" {
  description = "Name of the IAM role for authenticated users"
  value       = aws_iam_role.authenticated.name
}

output "unauthenticated_role_arn" {
  description = "ARN of the IAM role for unauthenticated users"
  value       = aws_iam_role.unauthenticated.arn
}
