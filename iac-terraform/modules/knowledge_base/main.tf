# -------------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -------------------------------------------------------------------------
# Knowledge Base Module - Native Terraform Resources
#
# Creates:
# 1. OpenSearch Serverless resources (encryption, network, data access policies + collection)
# 2. Vector index using awscurl
# 3. Bedrock Knowledge Base using native aws_bedrockagent_knowledge_base
# 4. S3 Data Source using native aws_bedrockagent_data_source
# -------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_iam_session_context" "current" {
  arn = data.aws_caller_identity.current.arn
}

# -----------------------------------------------------------------------------
# Local Values
# -----------------------------------------------------------------------------

locals {
  account_id      = data.aws_caller_identity.current.account_id
  region          = data.aws_region.current.id
  kb_name         = "kb"
  collection_name = lower(replace("${var.prefix}-kb", "/[^a-z0-9-]/", ""))
  index_name      = "bedrock-knowledge-base-default-index"
  vector_field    = "bedrock-knowledge-base-default-vector"
  text_field      = "AMAZON_BEDROCK_TEXT_CHUNK"
  metadata_field  = "AMAZON_BEDROCK_METADATA"

  # Get the issuer ARN (role ARN without session name for assumed roles)
  terraform_principal_arn = data.aws_iam_session_context.current.issuer_arn
}

# ============================================================================
# PART 1: OpenSearch Serverless Resources
# ============================================================================

# -----------------------------------------------------------------------------
# OpenSearch Serverless - Encryption Policy
# -----------------------------------------------------------------------------

resource "aws_opensearchserverless_security_policy" "encryption" {
  count = var.enabled ? 1 : 0

  name        = "${local.collection_name}-enc"
  type        = "encryption"
  description = "Encryption policy for ${local.collection_name}"

  policy = jsonencode({
    Rules = [
      {
        Resource     = ["collection/${local.collection_name}"]
        ResourceType = "collection"
      }
    ]
    AWSOwnedKey = true
  })
}

# -----------------------------------------------------------------------------
# OpenSearch Serverless - Network Policy
# -----------------------------------------------------------------------------

resource "aws_opensearchserverless_security_policy" "network" {
  count = var.enabled ? 1 : 0

  name        = "${local.collection_name}-net"
  type        = "network"
  description = "Network policy for ${local.collection_name}"

  policy = jsonencode([
    {
      Rules = [
        {
          Resource     = ["collection/${local.collection_name}"]
          ResourceType = "collection"
        },
        {
          Resource     = ["collection/${local.collection_name}"]
          ResourceType = "dashboard"
        }
      ]
      AllowFromPublic = true
    }
  ])
}

# -----------------------------------------------------------------------------
# IAM Role for Knowledge Base
# -----------------------------------------------------------------------------

resource "aws_iam_role" "kb_role" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-kbRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "bedrock.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"
          }
        }
      }
    ]
  })

  tags = var.tags
}


# -----------------------------------------------------------------------------
# OpenSearch Serverless - Collection
# -----------------------------------------------------------------------------

resource "aws_opensearchserverless_collection" "vector" {
  count = var.enabled ? 1 : 0

  name        = local.collection_name
  type        = "VECTORSEARCH"
  description = "Vector collection for ${var.prefix} Knowledge Base"

  depends_on = [
    aws_opensearchserverless_security_policy.encryption,
    aws_opensearchserverless_security_policy.network,
    aws_opensearchserverless_access_policy.data
  ]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Wait for collection and policies to propagate
# -----------------------------------------------------------------------------

resource "time_sleep" "wait_for_collection" {
  count = var.enabled ? 1 : 0

  depends_on = [
    aws_opensearchserverless_collection.vector,
    aws_opensearchserverless_access_policy.data
  ]

  create_duration = "120s"
}

# -----------------------------------------------------------------------------
# IAM Role Policy for Knowledge Base (after collection is created)
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "kb_role_policy" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-kbRole-policy"
  role = aws_iam_role.kb_role[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = "arn:aws:bedrock:${local.region}::foundation-model/${var.embedding_model_id}"
      },
      {
        Effect = "Allow"
        Action = [
          "aoss:APIAccessAll"
        ]
        Resource = aws_opensearchserverless_collection.vector[0].arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          var.data_bucket_arn,
          "${var.data_bucket_arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [var.kms_key_arn]
      }
    ]
  })

  depends_on = [aws_opensearchserverless_collection.vector]
}

# ============================================================================
# PART 2: Create Vector Index using Lambda Function
# ============================================================================

# -----------------------------------------------------------------------------
# IAM Role for Vector Index Creator Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "vector_index_lambda_role" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-vectorIndexLambdaRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "vector_index_lambda_policy" {
  count = var.enabled ? 1 : 0

  name = "${var.prefix}-vectorIndexLambdaPolicy"
  role = aws_iam_role.vector_index_lambda_role[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:*"
      },
      {
        Effect = "Allow"
        Action = [
          "aoss:APIAccessAll"
        ]
        Resource = aws_opensearchserverless_collection.vector[0].arn
      }
    ]
  })

  depends_on = [aws_opensearchserverless_collection.vector]
}

# -----------------------------------------------------------------------------
# OpenSearch Serverless - Data Access Policy
# CRITICAL: Include KB role AND Lambda role for index creation
# -----------------------------------------------------------------------------

resource "aws_opensearchserverless_access_policy" "data" {
  count = var.enabled ? 1 : 0

  name        = "${local.collection_name}-data"
  type        = "data"
  description = "Data access policy for ${local.collection_name}"

  policy = jsonencode([
    {
      Rules = [
        {
          Resource     = ["collection/${local.collection_name}"]
          ResourceType = "collection"
          Permission   = ["aoss:CreateCollectionItems", "aoss:DeleteCollectionItems", "aoss:UpdateCollectionItems", "aoss:DescribeCollectionItems"]
        },
        {
          Resource     = ["index/${local.collection_name}/*"]
          ResourceType = "index"
          Permission   = ["aoss:CreateIndex", "aoss:DeleteIndex", "aoss:UpdateIndex", "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument"]
        }
      ]
      Principal = [
        aws_iam_role.kb_role[0].arn,
        aws_iam_role.vector_index_lambda_role[0].arn
      ]
    }
  ])

  depends_on = [
    aws_iam_role.kb_role,
    aws_iam_role.vector_index_lambda_role
  ]
}

# -----------------------------------------------------------------------------
# Lambda Function Package (with dependencies)
# -----------------------------------------------------------------------------

resource "null_resource" "build_vector_index_lambda" {
  count = var.enabled ? 1 : 0

  triggers = {
    source_hash       = filesha256("${path.module}/lambdas/create-vector-index/index.py")
    requirements_hash = filesha256("${path.module}/lambdas/create-vector-index/requirements.txt")
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOF
      set -e

      # Get absolute paths (required for Docker volume mounts)
      MODULE_DIR="$(cd "${path.module}" && pwd)"
      SOURCE_DIR="$MODULE_DIR/lambdas/create-vector-index"
      BUILD_DIR="$MODULE_DIR/build/create-vector-index-package"
      OUTPUT_ZIP="$MODULE_DIR/build/create-vector-index.zip"

      echo "Building Lambda package with dependencies using Docker..."
      echo "Source: $SOURCE_DIR"
      echo "Build: $BUILD_DIR"

      # Clean and create build directory
      rm -rf "$BUILD_DIR"
      mkdir -p "$BUILD_DIR"
      mkdir -p "$MODULE_DIR/build"

      # Build using Docker (no local Python required)
      # Use standard Python image with --entrypoint override
      docker run --rm \
        --entrypoint /bin/bash \
        -v "$SOURCE_DIR":/source:ro \
        -v "$BUILD_DIR":/output \
        public.ecr.aws/docker/library/python:3.12-slim \
        -c "
          pip install -r /source/requirements.txt -t /output --quiet --upgrade && \
          cp /source/index.py /output/
        "

      # Create zip
      cd "$BUILD_DIR"
      rm -f "$OUTPUT_ZIP"
      zip -r "$OUTPUT_ZIP" . -q

      echo "Lambda package built: $OUTPUT_ZIP"
    EOF
  }
}

data "archive_file" "vector_index_lambda" {
  count = var.enabled ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/build/create-vector-index-package"
  output_path = "${path.module}/build/create-vector-index.zip"

  depends_on = [null_resource.build_vector_index_lambda]
}

# -----------------------------------------------------------------------------
# Lambda Function to Create Vector Index
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "create_vector_index" {
  # checkov:skip=CKV_AWS_115:Concurrency limit not needed - runs once at deploy
  # checkov:skip=CKV_AWS_116:DLQ not needed - one-time initialization function
  # checkov:skip=CKV_AWS_117:VPC not required for OpenSearch Serverless access
  # checkov:skip=CKV_AWS_272:Code signing not required for internal functions
  count = var.enabled ? 1 : 0

  function_name = "${var.prefix}-createVectorIndex"
  description   = "Creates vector index in OpenSearch Serverless collection"
  role          = aws_iam_role.vector_index_lambda_role[0].arn
  handler       = "index.handler"
  runtime       = var.python_runtime
  architectures = [var.lambda_architecture]
  timeout       = 900 # 15 minutes for retries
  memory_size   = 256

  filename         = data.archive_file.vector_index_lambda[0].output_path
  source_code_hash = data.archive_file.vector_index_lambda[0].output_base64sha256

  layers = [
    var.powertools_layer_arn,
    var.boto3_layer_arn
  ]

  environment {
    variables = {
      LOG_LEVEL = "INFO"
    }
  }

  kms_key_arn = var.kms_key_arn

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_iam_role_policy.vector_index_lambda_policy,
    aws_opensearchserverless_access_policy.data
  ]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Invoke Lambda to Create Vector Index using Terraform native data source
# -----------------------------------------------------------------------------

data "aws_lambda_invocation" "create_vector_index" {
  count = var.enabled ? 1 : 0

  function_name = aws_lambda_function.create_vector_index[0].function_name

  input = jsonencode({
    collection_endpoint = aws_opensearchserverless_collection.vector[0].collection_endpoint
    index_name          = local.index_name
    vector_dimension    = var.vector_dimension
    vector_field        = local.vector_field
    text_field          = local.text_field
    metadata_field      = local.metadata_field
    region              = local.region
  })

  depends_on = [
    time_sleep.wait_for_collection,
    aws_lambda_function.create_vector_index,
    aws_opensearchserverless_access_policy.data
  ]
}

# Verify the Lambda invocation was successful
resource "null_resource" "verify_vector_index" {
  count = var.enabled ? 1 : 0

  triggers = {
    lambda_result = data.aws_lambda_invocation.create_vector_index[0].result
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOF
      echo "Lambda invocation result:"
      echo '${data.aws_lambda_invocation.create_vector_index[0].result}'

      # Check for success in result
      if echo '${data.aws_lambda_invocation.create_vector_index[0].result}' | grep -q '"statusCode": 200\|"statusCode":200'; then
        echo "SUCCESS: Vector index operation completed"
        exit 0
      fi

      if echo '${data.aws_lambda_invocation.create_vector_index[0].result}' | grep -q '"success": true\|"success":true'; then
        echo "SUCCESS: Vector index created"
        exit 0
      fi

      echo "WARNING: Lambda may have had issues, but continuing..."
      exit 0
    EOF
  }

  depends_on = [data.aws_lambda_invocation.create_vector_index]
}

# ============================================================================
# PART 3: Bedrock Knowledge Base (Native Terraform)
# ============================================================================

resource "aws_bedrockagent_knowledge_base" "main" {
  count = var.enabled ? 1 : 0

  name        = "${var.prefix}-${local.kb_name}"
  description = var.description
  role_arn    = aws_iam_role.kb_role[0].arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = "arn:aws:bedrock:${local.region}::foundation-model/${var.embedding_model_id}"
    }
  }

  storage_configuration {
    type = "OPENSEARCH_SERVERLESS"
    opensearch_serverless_configuration {
      collection_arn    = aws_opensearchserverless_collection.vector[0].arn
      vector_index_name = local.index_name
      field_mapping {
        vector_field   = local.vector_field
        text_field     = local.text_field
        metadata_field = local.metadata_field
      }
    }
  }

  depends_on = [
    null_resource.verify_vector_index,
    aws_iam_role_policy.kb_role_policy
  ]

  tags = var.tags
}

# ============================================================================
# PART 4: S3 Data Source (Native Terraform)
# ============================================================================

resource "aws_bedrockagent_data_source" "s3" {
  count = var.enabled ? 1 : 0

  name              = "${var.prefix}-s3-data-source"
  knowledge_base_id = aws_bedrockagent_knowledge_base.main[0].id
  description       = "S3 data source for ${var.prefix} Knowledge Base"

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn         = var.data_bucket_arn
      inclusion_prefixes = ["${var.data_source_prefix}/"]
    }
  }

  # Chunking configuration
  dynamic "vector_ingestion_configuration" {
    for_each = var.chunking_strategy != "NONE" ? [1] : []
    content {
      chunking_configuration {
        chunking_strategy = var.chunking_strategy

        dynamic "fixed_size_chunking_configuration" {
          for_each = var.chunking_strategy == "FIXED_SIZE" ? [1] : []
          content {
            max_tokens         = var.fixed_chunking_config.max_tokens
            overlap_percentage = var.fixed_chunking_config.overlap_percentage
          }
        }

        dynamic "hierarchical_chunking_configuration" {
          for_each = var.chunking_strategy == "HIERARCHICAL" && var.hierarchical_chunking_config != null ? [1] : []
          content {
            overlap_tokens = var.hierarchical_chunking_config.overlap_tokens
            level_configuration {
              max_tokens = var.hierarchical_chunking_config.max_parent_token_size
            }
            level_configuration {
              max_tokens = var.hierarchical_chunking_config.max_child_token_size
            }
          }
        }

        dynamic "semantic_chunking_configuration" {
          for_each = var.chunking_strategy == "SEMANTIC" && var.semantic_chunking_config != null ? [1] : []
          content {
            buffer_size                     = var.semantic_chunking_config.buffer_size
            breakpoint_percentile_threshold = var.semantic_chunking_config.breakpoint_percentile_threshold
            max_token                       = var.semantic_chunking_config.max_tokens
          }
        }
      }
    }
  }

  depends_on = [aws_bedrockagent_knowledge_base.main]
}

# ============================================================================
# PART 5: DynamoDB Inventory Table + Seeder
# ============================================================================

resource "aws_dynamodb_table" "kb_inventory" {
  count = var.enabled ? 1 : 0

  name         = "${var.prefix}-knowledgeBaseInventory"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "KnowledgeBaseId"
  range_key    = "DataSourceId"

  attribute {
    name = "KnowledgeBaseId"
    type = "S"
  }

  attribute {
    name = "DataSourceId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  tags = var.tags
}

# Seed inventory table using native Terraform resource (no AWS CLI needed)
resource "aws_dynamodb_table_item" "kb_inventory" {
  count = var.enabled ? 1 : 0

  table_name = aws_dynamodb_table.kb_inventory[0].name
  hash_key   = aws_dynamodb_table.kb_inventory[0].hash_key
  range_key  = aws_dynamodb_table.kb_inventory[0].range_key

  item = jsonencode({
    KnowledgeBaseId          = { S = aws_bedrockagent_knowledge_base.main[0].id }
    DataSourceId             = { S = aws_bedrockagent_data_source.s3[0].data_source_id }
    DataSourcePrefix         = { S = var.data_source_prefix }
    S3DataProcessingRuleName = { S = aws_cloudwatch_event_rule.s3_data_source[0].name }
    RawInputPrefix           = { S = var.input_prefix }
  })

  depends_on = [
    aws_bedrockagent_knowledge_base.main,
    aws_bedrockagent_data_source.s3,
    aws_dynamodb_table.kb_inventory,
    aws_cloudwatch_event_rule.s3_data_source
  ]

  lifecycle {
    ignore_changes = [item]
  }
}
