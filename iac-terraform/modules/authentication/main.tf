/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

locals {
  # Lowercase prefix for resource naming (matches CDK generatePrefix behavior)
  name_prefix = lower(var.prefix)
}

# Get current AWS region for constructing console URLs
data "aws_region" "current" {}

# Get current AWS account ID for IAM policies
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Cognito User Pool
# Creates a user pool for managing user accounts and authentication
# Matches CDK: new cognito.UserPool(this, "UserPool", {...})
# -----------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  name = "${local.name_prefix}-userPool"

  # Sign-in configuration - email as username
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # MFA configuration - optional with TOTP only (no SMS)
  # Uses authenticator apps like Authy, Google Authenticator, Microsoft Authenticator
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  # Self sign-up disabled (matches CDK selfSignUpEnabled: false)
  # Note: This is controlled via admin_create_user_config
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Standard attributes configuration (matches CDK standardAttributes)
  schema {
    name                = "given_name"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    name                = "family_name"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  # Password policy - using defaults which match CDK defaults:
  # min length 8, requires lowercase, uppercase, numbers, symbols
  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  # Account recovery - email only (no SMS)
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Deletion protection disabled to match CDK removalPolicy: DESTROY
  deletion_protection = "INACTIVE"

  tags = {
    Name = "${local.name_prefix}-userPool"
  }
}

# -----------------------------------------------------------------------------
# Cognito User Pool Client
# Application client for accessing the User Pool
# Matches CDK: userPool.addClient("UserPoolClient", {...})
# -----------------------------------------------------------------------------
resource "aws_cognito_user_pool_client" "main" {
  name         = "${local.name_prefix}-userPoolClient"
  user_pool_id = aws_cognito_user_pool.main.id

  # No client secret (matches CDK generateSecret: false)
  generate_secret = false

  # Auth flows (matches CDK authFlows configuration)
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH", # adminUserPassword: true
    "ALLOW_USER_PASSWORD_AUTH",       # userPassword: true
    "ALLOW_USER_SRP_AUTH",            # userSrp: true
    "ALLOW_REFRESH_TOKEN_AUTH"        # Always needed for token refresh
  ]

  # Token validity settings (using sensible defaults)
  access_token_validity  = 1  # hours
  id_token_validity      = 1  # hours
  refresh_token_validity = 30 # days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # Prevent user existence errors
  prevent_user_existence_errors = "ENABLED"
}

# -----------------------------------------------------------------------------
# Cognito Identity Pool
# Provides temporary AWS credentials for authenticated and unauthenticated users
# Matches CDK: new cognitoIdentityPool.IdentityPool(this, "IdentityPool", {...})
# -----------------------------------------------------------------------------
resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = "${local.name_prefix}-identityPool"
  allow_unauthenticated_identities = false
  allow_classic_flow               = false

  cognito_identity_providers {
    client_id               = aws_cognito_user_pool_client.main.id
    provider_name           = aws_cognito_user_pool.main.endpoint
    server_side_token_check = true
  }

  tags = {
    Name = "${local.name_prefix}-identityPool"
  }
}

# -----------------------------------------------------------------------------
# IAM Roles for Identity Pool
# These are created implicitly by CDK's IdentityPool construct
# -----------------------------------------------------------------------------

# IAM Role for authenticated users
resource "aws_iam_role" "authenticated" {
  name = "${local.name_prefix}-cognito-authenticated-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = "cognito-identity.amazonaws.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "cognito-identity.amazonaws.com:aud" = aws_cognito_identity_pool.main.id
          }
          "ForAnyValue:StringLike" = {
            "cognito-identity.amazonaws.com:amr" = "authenticated"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-cognito-authenticated-role"
  }
}

# Basic policy for authenticated users (can be extended as needed)
resource "aws_iam_role_policy" "authenticated" {
  # checkov:skip=CKV_AWS_290:Cognito Identity Pool authenticated role requires cognito-sync/identity write permissions - standard AWS pattern
  # checkov:skip=CKV_AWS_287:Cognito Identity Pool authenticated role requires cognito-identity:* for token operations - standard AWS pattern
  # checkov:skip=CKV_AWS_289:Cognito Identity Pool authenticated role requires cognito-sync/identity permissions management - standard AWS pattern
  # checkov:skip=CKV_AWS_355:Cognito Identity Pool authenticated role cannot restrict resources as identity IDs are dynamic at runtime - standard AWS pattern
  name = "${local.name_prefix}-cognito-authenticated-policy"
  role = aws_iam_role.authenticated.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cognito-sync:*",
          "cognito-identity:*"
        ]
        Resource = "*"
      }
    ]
  })
}

# IAM Role for unauthenticated users (required even if not allowing unauth access)
resource "aws_iam_role" "unauthenticated" {
  name = "${local.name_prefix}-cognito-unauthenticated-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = "cognito-identity.amazonaws.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "cognito-identity.amazonaws.com:aud" = aws_cognito_identity_pool.main.id
          }
          "ForAnyValue:StringLike" = {
            "cognito-identity.amazonaws.com:amr" = "unauthenticated"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${local.name_prefix}-cognito-unauthenticated-role"
  }
}

# Minimal policy for unauthenticated users (denies all by default)
resource "aws_iam_role_policy" "unauthenticated" {
  name = "${local.name_prefix}-cognito-unauthenticated-policy"
  role = aws_iam_role.unauthenticated.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Deny"
        Action   = "*"
        Resource = "*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Identity Pool Roles Attachment
# Attaches the IAM roles to the Identity Pool
# -----------------------------------------------------------------------------
resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    "authenticated"   = aws_iam_role.authenticated.arn
    "unauthenticated" = aws_iam_role.unauthenticated.arn
  }
}
