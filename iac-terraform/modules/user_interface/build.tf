/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - Build and Deploy

Creates:
- aws-exports.json configuration file
- React app build via npm
- S3 deployment
- CloudFront cache invalidation
*/

# -----------------------------------------------------------------------------
# Generate aws-exports.json
# This config file is needed by the React app to connect to AWS services
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

# -----------------------------------------------------------------------------
# Build React App
# Runs npm ci and npm run build
# -----------------------------------------------------------------------------

resource "null_resource" "build_react_app" {
  triggers = {
    # Rebuild when aws-exports.json changes
    aws_exports_hash = local_file.aws_exports.content_sha256
    # Rebuild when package.json changes (new dependencies)
    package_json_hash = filesha256("${local.react_app_path}/package.json")
    # Rebuild when React source code changes (.tsx, .ts, .css, etc.)
    source_hash = sha256(join("", [
      for f in sort(fileset("${local.react_app_path}/src", "**")) :
      filesha256("${local.react_app_path}/src/${f}")
    ]))
    # Rebuild when CloudFront distribution changes (for cache invalidation)
    distribution_id = aws_cloudfront_distribution.website.id
  }

  provisioner "local-exec" {
    working_dir = local.react_app_path
    command     = "npm ci --silent && npm run build --silent"
  }

  depends_on = [local_file.aws_exports]
}

# -----------------------------------------------------------------------------
# Deploy to S3
# Sync built files to website bucket
# -----------------------------------------------------------------------------

resource "null_resource" "deploy_to_s3" {
  triggers = {
    build_hash      = null_resource.build_react_app.id
    distribution_id = aws_cloudfront_distribution.website.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws s3 sync ${local.build_path} s3://${aws_s3_bucket.website.id} \
        --delete \
        --region ${data.aws_region.current.id} \
        ${local.aws_profile_arg}
    EOT
  }

  depends_on = [
    null_resource.build_react_app,
    aws_s3_bucket_policy.website,
  ]
}

# -----------------------------------------------------------------------------
# Invalidate CloudFront Cache
# Clear cache after deployment
# -----------------------------------------------------------------------------

resource "null_resource" "invalidate_cache" {
  triggers = {
    deploy_hash = null_resource.deploy_to_s3.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws cloudfront create-invalidation \
        --distribution-id ${aws_cloudfront_distribution.website.id} \
        --paths "/*" \
        --region ${data.aws_region.current.id} \
        ${local.aws_profile_arg}
    EOT
  }

  depends_on = [null_resource.deploy_to_s3]
}
