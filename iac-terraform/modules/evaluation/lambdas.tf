/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - Lambda Functions

Creates:
- EvaluationResolver: Handles CRUD operations, submits test cases to SQS
- EvaluationExecutor: Processes individual test cases from SQS (bundled with strands-agents-evals)
*/

# -----------------------------------------------------------------------------
# EvaluationResolver Lambda
# Handles: listEvaluators, getEvaluator, createEvaluator, deleteEvaluator, runEvaluation
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "evaluation_resolver" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 30 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-evaluation-resolver"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-resolver-logs"
  })
}

data "archive_file" "evaluation_resolver" {
  type        = "zip"
  source_dir  = "${local.functions_dir}/evaluation-resolver"
  output_path = "${path.module}/../../../iac-terraform/build/evaluation-resolver.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]
}

resource "aws_lambda_function" "evaluation_resolver" {
  # checkov:skip=CKV_AWS_116:DLQ not needed for synchronous API resolver
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed at account level
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-evaluation-resolver"
  description   = "Handles evaluation CRUD operations and submits test cases to SQS"

  filename         = data.archive_file.evaluation_resolver.output_path
  source_code_hash = data.archive_file.evaluation_resolver.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 30
  memory_size      = 512

  role = aws_iam_role.evaluation_resolver.arn

  layers = [var.powertools_layer_arn]

  environment {
    variables = {
      POWERTOOLS_SERVICE_NAME = "evaluation-resolver"
      POWERTOOLS_LOG_LEVEL    = "INFO"
      EVALUATIONS_TABLE       = var.evaluators_table_name
      EVALUATIONS_BUCKET      = aws_s3_bucket.evaluations.id
      EVALUATION_QUEUE_URL    = aws_sqs_queue.evaluation.url
      BY_USER_ID_INDEX        = var.by_user_id_index
      ACCOUNT_ID              = data.aws_caller_identity.current.account_id
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.evaluation_resolver]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-resolver"
  })
}

# -----------------------------------------------------------------------------
# EvaluationExecutor Lambda
# Processes individual test cases from SQS queue
# Bundled with strands-agents-evals via build script
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "evaluation_executor" {
  # checkov:skip=CKV_AWS_338:Log retention configurable, 30 days acceptable
  name              = "/aws/lambda/${local.name_prefix}-evaluation-executor"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-executor-logs"
  })
}

# Build the executor package with strands-agents-evals bundled
# Uses Docker to avoid requiring local Python/pip and to compile packages for Linux (Lambda runtime)
resource "null_resource" "evaluation_executor_deps" {
  triggers = {
    requirements = filemd5("${local.functions_dir}/evaluation-executor/evaluator.py")
    index        = filemd5("${local.functions_dir}/evaluation-executor/index.py")
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOF
      set -e

      # Get absolute paths (required for Docker volume mounts)
      MODULE_DIR="$(cd "${path.module}" && pwd)"
      SOURCE_DIR="$(cd "${local.functions_dir}/evaluation-executor" && pwd)"
      BUILD_DIR="$(cd "${path.module}/../../.." && pwd)/iac-terraform/build/evaluation-executor-package"

      echo "Building evaluation executor Lambda package with Docker..."
      echo "Source: $SOURCE_DIR"
      echo "Build:  $BUILD_DIR"

      # Clean and create build directory
      rm -rf "$BUILD_DIR"
      mkdir -p "$BUILD_DIR"

      # Map Lambda architecture to Docker platform
      LAMBDA_ARCH="${var.lambda_architecture}"
      if [ "$LAMBDA_ARCH" = "arm64" ]; then
        DOCKER_PLATFORM="linux/arm64"
      else
        DOCKER_PLATFORM="linux/amd64"
      fi

      # Build using Docker (consistent with knowledge_base module approach)
      # Strips tests and __pycache__ to reduce package size (dist-info kept for entry_points discovery)
      # Uses --platform to compile native extensions (.so) for the correct Lambda architecture
      # Extract Python minor version from runtime (e.g., "python3.14" -> "3.14")
      PYTHON_VERSION=$(echo "${var.python_runtime}" | sed 's/python//')

      docker run --rm \
        --platform "$DOCKER_PLATFORM" \
        --entrypoint /bin/bash \
        -v "$SOURCE_DIR":/source:ro \
        -v "$BUILD_DIR":/output \
        "public.ecr.aws/docker/library/python:$PYTHON_VERSION-slim" \
        -c "
          pip install strands-agents-evals -t /output --quiet --upgrade && \
          cp /source/*.py /output/ && \
          find /output -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null; \
          find /output -type d -name 'tests' -exec rm -rf {} + 2>/dev/null; \
          find /output -type d -name 'test' -exec rm -rf {} + 2>/dev/null; \
          find /output -type f -name '*.pyc' -delete 2>/dev/null; \
          true
        "

      echo "Evaluation executor package built: $BUILD_DIR"
    EOF
  }
}

data "archive_file" "evaluation_executor" {
  type        = "zip"
  source_dir  = "${path.module}/../../../iac-terraform/build/evaluation-executor-package"
  output_path = "${path.module}/../../../iac-terraform/build/evaluation-executor.zip"
  excludes    = ["__pycache__", "*.pyc", ".pytest_cache"]

  depends_on = [null_resource.evaluation_executor_deps]
}

# Upload to S3 first — the bundled zip (~80MB) exceeds Lambda's direct upload limit (67MB)
resource "aws_s3_object" "evaluation_executor_code" {
  bucket      = aws_s3_bucket.evaluations.id
  key         = "lambda-code/evaluation-executor.zip"
  source      = data.archive_file.evaluation_executor.output_path
  source_hash = data.archive_file.evaluation_executor.output_md5

  depends_on = [data.archive_file.evaluation_executor]
}

resource "aws_lambda_function" "evaluation_executor" {
  # checkov:skip=CKV_AWS_116:DLQ handled by SQS redrive policy
  # checkov:skip=CKV_AWS_117:VPC not required for this function
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  # checkov:skip=CKV_AWS_115:Concurrency limit managed via SQS event source maxConcurrency
  # checkov:skip=CKV_AWS_173:Environment variables do not contain secrets
  function_name = "${local.name_prefix}-evaluation-executor"
  description   = "Processes individual evaluation test cases from SQS"

  s3_bucket        = aws_s3_object.evaluation_executor_code.bucket
  s3_key           = aws_s3_object.evaluation_executor_code.key
  source_code_hash = data.archive_file.evaluation_executor.output_base64sha256
  handler          = "index.handler"
  runtime          = var.python_runtime
  architectures    = [var.lambda_architecture]
  timeout          = 900 # 15 minutes
  memory_size      = 2048

  role = aws_iam_role.evaluation_executor.arn

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn,
    var.genai_core_layer_arn,
  ]

  environment {
    variables = {
      POWERTOOLS_SERVICE_NAME = "evaluation-executor"
      POWERTOOLS_LOG_LEVEL    = "INFO"
      REGION_NAME             = data.aws_region.current.id
      EVALUATIONS_TABLE       = var.evaluators_table_name
      EVALUATIONS_BUCKET      = aws_s3_bucket.evaluations.id
      ACCOUNT_ID              = data.aws_caller_identity.current.account_id
      APPSYNC_API_ENDPOINT    = var.graphql_url
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.evaluation_executor]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-evaluation-executor"
  })
}

# -----------------------------------------------------------------------------
# SQS Event Source Mapping
# Connects the evaluation queue to the executor Lambda
# -----------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "evaluation_executor" {
  event_source_arn = aws_sqs_queue.evaluation.arn
  function_name    = aws_lambda_function.evaluation_executor.arn
  batch_size       = 1 # Process one test case at a time
  enabled          = true

  scaling_config {
    maximum_concurrency = 50 # Throttling limit (prevents overwhelming Bedrock/AgentCore)
  }

  function_response_types = ["ReportBatchItemFailures"]
}
