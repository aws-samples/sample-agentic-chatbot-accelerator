/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - Build Configuration

Creates:
- aws-exports.json configuration file (consumed by CodeBuild)

Note: The actual build, S3 deployment, and CloudFront invalidation
are handled by CodeBuild (see codebuild.tf)
*/

# -----------------------------------------------------------------------------
# Generate aws-exports.json
# This config file is needed by the React app to connect to AWS services
# It's uploaded to S3 and downloaded by CodeBuild during the build process
# -----------------------------------------------------------------------------

resource "local_file" "aws_exports" {
  filename = "${local.react_app_path}/public/aws-exports.json"

  content = jsonencode(merge(
    {
      aws_project_region           = data.aws_region.current.id
      aws_cognito_region           = data.aws_region.current.id
      aws_user_pools_id            = var.user_pool_id
      aws_user_pools_web_client_id = var.user_pool_client_id
      aws_cognito_identity_pool_id = var.identity_pool_id
      Auth = {
        region              = data.aws_region.current.id
        userPoolId          = var.user_pool_id
        userPoolWebClientId = var.user_pool_client_id
      }
      aws_appsync_graphqlEndpoint            = var.graphql_url
      aws_appsync_region                     = data.aws_region.current.id
      aws_appsync_authenticationType         = "AMAZON_COGNITO_USER_POOLS"
      aws_bedrock_supported_models           = var.supported_models
      aws_bedrock_supported_reranking_models = var.reranking_models
      knowledgeBaseIsSupported               = var.knowledge_base_supported
      config                                 = {}
    },
    # Add S3 bucket config only if data_bucket_name is provided (matches CDK format)
    var.data_bucket_name != "" ? {
      aws_user_files_s3_bucket        = var.data_bucket_name
      aws_user_files_s3_bucket_region = data.aws_region.current.id
    } : {},
    # Add evaluator config if provided (models, threshold, rubrics for evaluation wizard)
    var.evaluator_config != null ? {
      evaluatorConfig = {
        supportedModels = var.evaluator_config.supported_models
        passThreshold   = var.evaluator_config.pass_threshold
        defaultRubrics  = var.evaluator_config.default_rubrics
      }
    } : {}
  ))
}
