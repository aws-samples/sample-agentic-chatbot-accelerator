# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Buildspec for building TypeScript Lambda functions via CodeBuild

version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: "20"
    commands:
      - echo "Installing dependencies..."
      - npm init -y
      - npm install --save-dev esbuild typescript @types/node @types/aws-lambda
      - npm install @aws-lambda-powertools/logger @aws-crypto/sha256-js @aws-sdk/credential-provider-node @aws-sdk/protocol-http @aws-sdk/signature-v4

  build:
    commands:
      - echo "Building TypeScript Lambda..."
      - ls -la
      - mkdir -p dist
      - npx esbuild index.ts --bundle --platform=node --target=node20 --outfile=dist/index.js --external:@aws-sdk/*
      - ls -lh dist/
      - echo "TypeScript Lambda build complete"

  post_build:
    commands:
      - cd dist && zip -r ../lambda.zip . && cd ..
      - aws s3 cp lambda.zip s3://${output_bucket}/${output_key}
      - echo "Uploaded to s3://${output_bucket}/${output_key}"

artifacts:
  files:
    - dist/**/*
  discard-paths: no
