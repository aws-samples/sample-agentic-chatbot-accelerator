# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Buildspec for building React web app and deploying to S3

version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: "20"
    commands:
      - echo "Installing dependencies..."
      - npm ci --silent

  pre_build:
    commands:
      - echo "Downloading aws-exports.json from S3..."
      - aws s3 cp s3://${config_bucket}/${config_key} public/aws-exports.json
      - echo "aws-exports.json downloaded"

  build:
    commands:
      - echo "Building React application..."
      - npm run build --silent
      - ls -lh dist/
      - echo "React build complete"

  post_build:
    commands:
      - echo "Deploying to S3..."
      - aws s3 sync dist/ s3://${website_bucket} --delete
      - echo "Deployed to s3://${website_bucket}"
      - echo "Invalidating CloudFront cache..."
      - aws cloudfront create-invalidation --distribution-id ${distribution_id} --paths "/*"
      - echo "CloudFront invalidation started"

artifacts:
  files:
    - dist/**/*
  discard-paths: no
