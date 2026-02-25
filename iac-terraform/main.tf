/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# ACA Stack - Terraform equivalent
# This is the root module that instantiates all infrastructure components.
# Equivalent to lib/aca-stack.ts in CDK.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Local Values
# Compose prefix from stack name and environment (e.g., "aca-dev")
# -----------------------------------------------------------------------------
locals {
  # Compose prefix from stack name and environment
  # Results in "aca-dev" when environment is set, "aca" when empty
  prefix = var.environment != "" ? "${var.prefix}-${var.environment}" : var.prefix
}

# Get current AWS account and region
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# Shared KMS Key
# Created at root level to avoid circular dependencies between modules
# Used by: agent_core, data_processing, knowledge_base, api_tables, appsync, etc.
# -----------------------------------------------------------------------------
resource "aws_kms_key" "main" {
  description             = "KMS key for ACA stack encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowSNSUseOfKey"
        Effect = "Allow"
        Principal = {
          Service = "sns.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey*",
          "kms:Decrypt"
        ]
        Resource = "*"
      },
      {
        Sid    = "AllowCloudWatchLogsUseOfKey"
        Effect = "Allow"
        Principal = {
          Service = "logs.${data.aws_region.current.id}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:*"
          }
        }
      },
      {
        Sid    = "AllowEventBridgeUseOfKey"
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey*",
          "kms:Decrypt"
        ]
        Resource = "*"
      }
    ]
  })

  tags = {
    Name = "${local.prefix}-main-kms"
  }
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.prefix}-main"
  target_key_id = aws_kms_key.main.key_id
}

# -----------------------------------------------------------------------------
# Shared Module
# Provides Lambda layers and common configuration
# Equivalent to: const shared = new Shared(this, "Shared", lambdaArchitectureId);
# -----------------------------------------------------------------------------
module "shared" {
  source = "./modules/shared"

  prefix              = local.prefix
  lambda_architecture = var.lambda_architecture
}

# -----------------------------------------------------------------------------
# Authentication Module
# Creates Cognito User Pool, User Pool Client, and Identity Pool
# Equivalent to: const auth = new Authentication(this, "Authentication", props.config);
# -----------------------------------------------------------------------------
module "authentication" {
  source = "./modules/authentication"

  prefix = local.prefix
}

# -----------------------------------------------------------------------------
# Agent Core Module
# Creates DynamoDB tables, ECR repository, IAM roles, and optionally
# Bedrock AgentCore Runtime and Memory
# Equivalent to: const agentCore = new AcaAgentCoreContainer(this, "AgentCoreContainer", {...});
# -----------------------------------------------------------------------------
module "agent_core" {
  source = "./modules/agent_core"

  prefix = local.prefix

  shared = {
    powertools_layer_arn          = module.shared.powertools_layer_arn
    boto3_layer_arn               = module.shared.boto3_layer_arn
    genai_core_layer_arn          = module.shared.genai_core_layer_arn
    python_runtime                = module.shared.python_runtime
    lambda_architecture           = module.shared.lambda_architecture
    default_environment_variables = module.shared.default_environment_variables
  }

  tool_registry       = var.tool_registry
  mcp_server_registry = var.mcp_server_registry

  # Optional: agent runtime configuration
  agent_runtime_config = var.agent_runtime_config

  # ECR image configuration
  ecr_image_tag = var.ecr_image_tag
  ecr_image_uri = var.ecr_image_uri

  # Tags for IAM conditions (AgentCore resource scoping)
  stack_tag       = var.prefix
  environment_tag = var.environment

  # Knowledge Base integration - inject kb_id into retrieve_from_kb tool parameters
  # NOTE: Set this via terraform.tfvars AFTER first deploy to avoid circular dependency
  # The knowledge_base module outputs the ID which you can then add here for subsequent applies
  knowledge_base_id = var.knowledge_base_id

  # KMS key from root level (breaks circular dependency)
  kms_key_arn = aws_kms_key.main.arn
  kms_key_id  = aws_kms_key.main.key_id

  depends_on = [module.shared, aws_kms_key.main]
}

# -----------------------------------------------------------------------------
# API Tables Module
# Creates DynamoDB tables for session and favorite runtime storage
# Equivalent to: new ChatbotDynamoDBTables(this, "ChatTables") in lib/api/tables/index.ts
# -----------------------------------------------------------------------------
module "api_tables" {
  source = "./modules/api_tables"

  prefix      = local.prefix
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [aws_kms_key.main]
}

# -----------------------------------------------------------------------------
# AppSync GraphQL API Module
# Creates the GraphQL API with Cognito and IAM authentication
# Equivalent to: new appsync.GraphqlApi(this, "ChatbotApi", {...}) in lib/api/index.ts
# -----------------------------------------------------------------------------
module "appsync" {
  source = "./modules/appsync"

  prefix           = local.prefix
  user_pool_id     = module.authentication.user_pool_id
  schema_file_path = "${path.module}/../lib/api/schema/schema.graphql"
  kms_key_arn      = aws_kms_key.main.arn

  depends_on = [module.authentication, aws_kms_key.main]
}

# -----------------------------------------------------------------------------
# HTTP API Resolver Module
# Creates Lambda function and AppSync resolvers for HTTP API operations
# Equivalent to: new HttpApiBackend(this, "SyncApiBackend", {...}) in lib/api/index.ts
# -----------------------------------------------------------------------------
module "http_api_resolver" {
  source = "./modules/http_api_resolver"

  prefix = local.prefix

  # AppSync
  appsync_api_id      = module.appsync.api_id
  graphql_schema_path = "${path.module}/../lib/api/schema/schema.graphql"

  # DynamoDB Tables
  sessions_table_name            = module.api_tables.sessions_table_name
  sessions_table_arn             = module.api_tables.sessions_table_arn
  sessions_by_user_index         = module.api_tables.sessions_table_by_user_index
  favorite_runtime_table_name    = module.api_tables.favorite_runtime_table_name
  favorite_runtime_table_arn     = module.api_tables.favorite_runtime_table_arn
  tool_registry_table_name       = module.agent_core.tool_registry_table_name
  tool_registry_table_arn        = module.agent_core.tool_registry_table_arn
  mcp_server_registry_table_name = module.agent_core.mcp_server_registry_table_name
  mcp_server_registry_table_arn  = module.agent_core.mcp_server_registry_table_arn

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = module.shared.lambda_architecture

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  # Operations handled by other modules (to be excluded from this resolver)
  # Same logic as CDK: operationToExclude: [...agentCoreApis.operations, ...kbApis.operations, ...evaluationApi.operations]
  operations_to_exclude = concat(
    # AgentCore APIs operations (always present)
    module.agent_core_apis.operations,
    # Knowledge Base APIs operations (when KB is enabled)
    var.knowledge_base != null && var.data_processing != null ? module.knowledge_base_apis[0].operations : [],
    # Evaluation API operations (always present)
    module.evaluation.operations,
  )

  depends_on = [module.appsync, module.api_tables, module.agent_core, module.agent_core_apis, module.evaluation]
}

# -----------------------------------------------------------------------------
# WebSocket Backend Module
# Creates SNS topic and Lambda for real-time messaging
# Equivalent to: new WebsocketApiBackend(this, "RealtimeBackend", {...}) in lib/api/index.ts
# -----------------------------------------------------------------------------
module "websocket_backend" {
  source = "./modules/websocket_backend"

  prefix = local.prefix

  # AppSync
  appsync_api_id = module.appsync.api_id
  graphql_url    = module.appsync.graphql_url

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.appsync, aws_kms_key.main]
}

# -----------------------------------------------------------------------------
# Agent Core APIs Module
# Creates Lambda functions, Step Functions, and AppSync resolvers for
# Bedrock AgentCore runtime lifecycle management
# Equivalent to: new AgentCoreApis(this, "AgentCoreApis", {...}) in lib/api/index.ts
# -----------------------------------------------------------------------------
module "agent_core_apis" {
  source = "./modules/agent_core_apis"

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = module.shared.lambda_architecture

  # Container (includes image tag like :latest)
  container_uri       = module.agent_core.container_uri
  swarm_container_uri = module.agent_core.swarm_container_uri

  # DynamoDB tables
  agent_core_runtime_table_name  = module.agent_core.agent_runtime_config_table_name
  agent_core_runtime_table_arn   = module.agent_core.agent_runtime_config_table_arn
  agent_core_summary_table_name  = module.agent_core.agent_summary_table_name
  agent_core_summary_table_arn   = module.agent_core.agent_summary_table_arn
  tool_registry_table_name       = module.agent_core.tool_registry_table_name
  tool_registry_table_arn        = module.agent_core.tool_registry_table_arn
  mcp_server_registry_table_name = module.agent_core.mcp_server_registry_table_name
  mcp_server_registry_table_arn  = module.agent_core.mcp_server_registry_table_arn

  # IAM
  agent_core_execution_role_arn = module.agent_core.execution_role_arn

  # SNS (from agent_core for agent tools notifications)
  agent_tools_topic_arn = module.agent_core.agent_tools_topic_arn

  # AppSync
  appsync_api_id = module.appsync.api_id
  graphql_url    = module.appsync.graphql_url

  # Tags for Bedrock AgentCore
  stack_tag       = var.prefix # Keep original stack name for tagging
  environment_tag = var.environment

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.appsync, module.agent_core, module.websocket_backend]
}

# -----------------------------------------------------------------------------
# GenAI Interface Module
# Creates Lambda functions for invoking AgentCore runtime and handling agent tools
# Equivalent to: new GenAIInterface(this, "GenAI", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "genai_interface" {
  source = "./modules/genai_interface"

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = module.shared.lambda_architecture

  # DynamoDB Tables
  sessions_table_name = module.api_tables.sessions_table_name
  sessions_table_arn  = module.api_tables.sessions_table_arn
  by_user_id_index    = module.api_tables.sessions_table_by_user_index

  # SNS Topics
  messages_topic_arn    = module.websocket_backend.messages_topic_arn
  agent_tools_topic_arn = module.agent_core.agent_tools_topic_arn

  # Tags for IAM conditions (AgentCore resource scoping)
  stack_tag       = var.prefix
  environment_tag = var.environment

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.api_tables, module.websocket_backend, module.agent_core]
}

# -----------------------------------------------------------------------------
# User Interface Module
# Creates S3 buckets, CloudFront distribution, builds and deploys React app
# Equivalent to: new UserInterface(this, "UserInterface", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "user_interface" {
  source = "./modules/user_interface"

  prefix = local.prefix

  # Cognito configuration
  user_pool_id        = module.authentication.user_pool_id
  user_pool_client_id = module.authentication.user_pool_client_id
  identity_pool_id    = module.authentication.identity_pool_id

  # AppSync configuration
  graphql_url = module.appsync.graphql_url

  # Feature configuration
  supported_models         = var.supported_models
  reranking_models         = var.reranking_models
  knowledge_base_supported = var.knowledge_base != null && var.data_processing != null

  # Data bucket for document uploads (from data_processing module)
  data_bucket_name = var.data_processing != null ? module.data_processing[0].data_bucket_name : ""

  # Evaluator configuration (optional - models, threshold, rubrics for evaluation wizard)
  evaluator_config = var.evaluator_config

  # Geo restrictions (optional)
  enable_geo_restrictions = var.enable_geo_restrictions
  allowed_geo_regions     = var.allowed_geo_regions

  # AWS CLI profile for S3 sync
  aws_profile = var.aws_profile

  depends_on = [module.authentication, module.appsync]
}

# -----------------------------------------------------------------------------
# S3 CORS Configuration for Data Bucket (when data_processing is enabled)
# Allows browser-based uploads via Amplify Storage
# Must be defined at root level to access CloudFront domain from user_interface
# Matches CDK configuration in lib/user-interface/index.ts
# -----------------------------------------------------------------------------
resource "aws_s3_bucket_cors_configuration" "data_bucket_cors" {
  count  = var.data_processing != null ? 1 : 0
  bucket = module.data_processing[0].data_bucket_id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST", "GET", "DELETE", "HEAD"]
    allowed_origins = [
      "https://${module.user_interface.distribution_domain_name}",
      "http://localhost:3000"
    ]
    expose_headers = [
      "ETag",
      "x-amz-server-side-encryption",
      "x-amz-request-id",
      "x-amz-id-2"
    ]
    max_age_seconds = 3000
  }

  depends_on = [module.data_processing, module.user_interface]
}

# -----------------------------------------------------------------------------
# IAM Policy for Cognito Authenticated Users to access Data Bucket
# Allows browser-based uploads via Amplify Storage
# Matches CDK configuration in lib/user-interface/index.ts:
#   props.identityPool.authenticatedRole.addToPrincipalPolicy(...)
# -----------------------------------------------------------------------------
resource "aws_iam_role_policy" "cognito_data_bucket_access" {
  count = var.data_processing != null ? 1 : 0
  name  = "${local.prefix}-cognito-data-bucket-access"
  role  = module.authentication.authenticated_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          module.data_processing[0].data_bucket_arn,
          "${module.data_processing[0].data_bucket_arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKey*"
        ]
        Resource = [aws_kms_key.main.arn]
      }
    ]
  })

  depends_on = [module.authentication, module.data_processing]
}

# -----------------------------------------------------------------------------
# Data Processing Module (Optional)
# Creates S3 buckets, DynamoDB table, Lambda functions, Step Functions,
# SQS queues, and EventBridge rules for document processing pipeline
# Equivalent to: new DataProcessing(this, "DataProcessing", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "data_processing" {
  source = "./modules/data_processing"
  count  = var.data_processing != null ? 1 : 0

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = var.lambda_architecture

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  # Data processing configuration
  input_prefix       = var.data_processing.input_prefix
  data_source_prefix = var.data_processing.data_source_prefix
  processing_prefix  = var.data_processing.processing_prefix
  staging_midfix     = var.data_processing.staging_midfix
  transcribe_midfix  = var.data_processing.transcribe_midfix
  language_code      = var.data_processing.language_code

  depends_on = [module.shared, module.agent_core]
}

# -----------------------------------------------------------------------------
# Knowledge Base Module (Optional)
# Creates Bedrock Knowledge Base with OpenSearch Serverless vector store
# using the aws-ia/bedrock community module
# Requires data_processing module to be enabled
# Equivalent to: new VectorKnowledgeBase(this, "KnowledgeBase", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "knowledge_base" {
  source = "./modules/knowledge_base"

  # Enable flag - requires both knowledge_base and data_processing configs
  enabled = var.knowledge_base != null && var.data_processing != null

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = var.lambda_architecture

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  # Data bucket from data_processing module (provide defaults when not enabled)
  data_bucket_name = var.data_processing != null ? module.data_processing[0].data_bucket_name : ""
  data_bucket_arn  = var.data_processing != null ? module.data_processing[0].data_bucket_arn : ""

  # Embedding model configuration
  embedding_model_id = try(var.knowledge_base.embedding_model_id, "amazon.titan-embed-text-v2:0")
  vector_dimension   = try(var.knowledge_base.vector_dimension, 1024)

  # Chunking strategy configuration
  chunking_strategy            = try(var.knowledge_base.chunking_strategy, "FIXED_SIZE")
  fixed_chunking_config        = try(var.knowledge_base.fixed_chunking_config, { max_tokens = 300, overlap_percentage = 20 })
  hierarchical_chunking_config = try(var.knowledge_base.hierarchical_chunking_config, null)
  semantic_chunking_config     = try(var.knowledge_base.semantic_chunking_config, null)

  # Data source configuration
  data_source_prefix = try(var.knowledge_base.data_source_prefix, "data-source")
  input_prefix       = try(var.data_processing.input_prefix, "input")
  description        = try(var.knowledge_base.description, "Knowledge Base for searching helpful information.")
}

# -----------------------------------------------------------------------------
# Knowledge Base APIs Module (Optional)
# Creates Lambda function and AppSync resolvers for Knowledge Base operations
# Requires both data_processing and knowledge_base modules to be enabled
# Equivalent to: KnowledgeBaseOps in lib/api/knowledge-base.ts
# -----------------------------------------------------------------------------
module "knowledge_base_apis" {
  source = "./modules/knowledge_base_apis"
  count  = var.knowledge_base != null && var.data_processing != null ? 1 : 0

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = var.lambda_architecture

  # AppSync
  appsync_api_id = module.appsync.api_id

  # From data_processing module
  document_table_name      = module.data_processing[0].document_state_table_name
  document_table_arn       = module.data_processing[0].document_state_table_arn
  data_bucket_name         = module.data_processing[0].data_bucket_name
  data_bucket_arn          = module.data_processing[0].data_bucket_arn
  queue_start_pipeline_arn = module.data_processing[0].pipeline_start_queue_arn

  # From knowledge_base module
  kb_inventory_table_name = module.knowledge_base.kb_inventory_table_name
  kb_inventory_table_arn  = module.knowledge_base.kb_inventory_table_arn
  kb_role_arn             = module.knowledge_base.kb_role_arn
  collection_id           = module.knowledge_base.collection_id
  collection_arn          = module.knowledge_base.collection_arn
  collection_name         = module.knowledge_base.collection_name

  # Tags
  stack_tag       = var.prefix
  environment_tag = var.environment

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.appsync, module.data_processing, module.knowledge_base]
}

# -----------------------------------------------------------------------------
# Evaluation Module
# Creates S3 buckets, SQS queues, Lambda functions, and AppSync resolvers
# for agent evaluation using the Strands Eval SDK
# Equivalent to: new EvaluationApi(this, "EvaluationApi", {...}) in lib/api/index.ts
# -----------------------------------------------------------------------------
module "evaluation" {
  source = "./modules/evaluation"

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  genai_core_layer_arn = module.shared.genai_core_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = module.shared.lambda_architecture

  # DynamoDB Tables
  evaluators_table_name = module.api_tables.evaluators_table_name
  evaluators_table_arn  = module.api_tables.evaluators_table_arn
  by_user_id_index      = module.api_tables.sessions_table_by_user_index

  # AppSync
  appsync_api_id = module.appsync.api_id
  graphql_url    = module.appsync.graphql_url

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.appsync, module.api_tables, aws_kms_key.main]
}

# -----------------------------------------------------------------------------
# Observability Module (Optional)
# Creates X-Ray Transaction Search and CloudWatch Dashboard for AgentCore
# Equivalent to: new Observability(this, "Observability", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "observability" {
  source = "./modules/observability"
  count  = var.observability != null ? 1 : 0

  prefix = local.prefix

  # Transaction Search configuration
  enable_transaction_search = try(var.observability.enable_transaction_search, true)
  indexing_percentage       = try(var.observability.indexing_percentage, 10)

  depends_on = [module.agent_core]
}

# -----------------------------------------------------------------------------
# Cleanup Module
# Creates Lambda function that runs during terraform destroy to clean up
# user-created resources (agents, knowledge bases, EventBridge rules)
# Equivalent to: new Cleanup(this, "CleanUpCustomResources", {...}) in lib/aca-stack.ts
# -----------------------------------------------------------------------------
module "cleanup" {
  source = "./modules/cleanup"

  prefix = local.prefix

  # Lambda configuration
  powertools_layer_arn = module.shared.powertools_layer_arn
  boto3_layer_arn      = module.shared.boto3_layer_arn
  python_runtime       = module.shared.python_runtime
  lambda_architecture  = var.lambda_architecture

  # Tags for resource identification during cleanup
  stack_tag       = var.prefix
  environment_tag = var.environment

  # Knowledge base enabled flag (used for count to avoid unknown value issues)
  kb_enabled = var.knowledge_base != null && var.data_processing != null

  # IaC-managed resources to PRESERVE (not delete) during cleanup
  # The Terraform-managed Knowledge Base ID (if exists)
  iac_knowledge_base_ids = module.knowledge_base.knowledge_base_id != null ? module.knowledge_base.knowledge_base_id : ""
  # IaC-managed EventBridge rules (comma-separated) - sync rules are managed by Terraform
  iac_rule_names = module.knowledge_base.s3_event_rule_name != null ? module.knowledge_base.s3_event_rule_name : ""

  # KB inventory table for discovering user-created knowledge bases
  kb_inventory_table_name = module.knowledge_base.kb_inventory_table_name != null ? module.knowledge_base.kb_inventory_table_name : ""
  kb_inventory_table_arn  = module.knowledge_base.kb_inventory_table_arn != null ? module.knowledge_base.kb_inventory_table_arn : ""

  # Encryption
  kms_key_arn = aws_kms_key.main.arn

  depends_on = [module.knowledge_base, module.agent_core]
}
