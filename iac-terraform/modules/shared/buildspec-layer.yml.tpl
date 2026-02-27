# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Buildspec for building Lambda layers via CodeBuild

version: 0.2

phases:
  install:
    runtime-versions:
      python: "3.12"

  build:
    commands:
      - echo "Building Lambda layer..."
      - echo "Architecture $CODEBUILD_BUILD_ARN"
      - mkdir -p python
      - pip install -r requirements.txt -t python/ --quiet
      - find python -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
      - find python -type f -name '*.pyc' -delete 2>/dev/null || true
      - find python -type d -name tests -exec rm -rf {} + 2>/dev/null || true
      - find python -type d -name test -exec rm -rf {} + 2>/dev/null || true
      - zip -r layer.zip python -q
      - ls -lh layer.zip
      - echo "Layer build complete"

  post_build:
    commands:
      - aws s3 cp layer.zip s3://${output_bucket}/${output_key}
      - echo "Uploaded to s3://${output_bucket}/${output_key}"

artifacts:
  files:
    - layer.zip
  discard-paths: yes
