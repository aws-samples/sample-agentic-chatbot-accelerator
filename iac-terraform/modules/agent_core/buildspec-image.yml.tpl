## Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
## SPDX-License-Identifier: MIT-0
##
## Buildspec for CodeBuild: build and push a Docker image to ECR.
## Templated by Terraform — ecr_repo_url, aws_region, account_id are injected.

version: 0.2

env:
  variables:
    ECR_REPO_URL: "${ecr_repo_url}"
    AWS_DEFAULT_REGION: "${aws_region}"
    AWS_ACCOUNT_ID: "${account_id}"

phases:
  pre_build:
    commands:
      - 'echo "Authenticating to ECR..."'
      - 'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
      - 'echo "IMAGE_TAG=$IMAGE_TAG"'
      - 'echo "ECR_REPO_URL=$ECR_REPO_URL"'

  build:
    commands:
      - 'echo "Building Docker image..."'
      - 'docker build -t "$ECR_REPO_URL:$IMAGE_TAG" .'
      - 'echo "Build complete."'

  post_build:
    commands:
      - 'echo "Pushing image to ECR..."'
      - 'docker push "$ECR_REPO_URL:$IMAGE_TAG"'
      - 'echo "Image pushed successfully."'
