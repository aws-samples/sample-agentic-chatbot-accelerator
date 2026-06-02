# Feature matrix

This is the source of truth for which features exist, what they require, and how they interact. The authoritative type definitions live in `iac-cdk/lib/shared/types.ts`. The Terraform variable types live in `iac-terraform/variables.tf`. When in doubt, re-read those files — this matrix is a digest, not a replacement.

## Top-level required fields

| Field (CDK) | Field (TF) | Type | Default | Notes |
|---|---|---|---|---|
| `prefix` | `prefix` | string | none — must ask | Used in resource names. Letters/digits/hyphens; starts with a letter. |
| `enableGeoRestrictions` | (no direct TF mirror) | bool | `false` | CloudFront geo block. |
| `allowedGeoRegions` | (no direct TF mirror) | string[] | `[]` | ISO 3166-1 alpha-2 codes. Only used when `enableGeoRestrictions: true`. |
| `supportedModels` | `supported_models` | map<display→modelId> | three Bedrock models (see `config.ts`) | Keep `[REGION-PREFIX]` placeholder unless the user pins a region. |
| `toolRegistry` | `tool_registry` | array of `{name, description, invokesSubAgent/invokes_sub_agent}` | `[]` | If `agentRuntimeConfig` is set, default to `[{name: "invoke_subagent", description: "...", invokesSubAgent: true}]`. |
| `mcpServerRegistry` | `mcp_server_registry` | array | `[]` | See MCP section below. |
| `ingestionLambdaProps` | (no direct TF mirror — defaults bake in) | `{timeoutInMinutes, reservedConcurrency?}` | `{3, 20}` | CDK-only construct. |
| (TF only) `aws_region` | — | string | `us-east-1` |  |
| (TF only) `environment` | — | string | `""` | Combined with prefix → `aca-dev-xxx`. |
| (TF only) `lambda_architecture` | — | `"arm64"` \| `"x86_64"` | `arm64` |  |
| (TF only) `bedrock_access_role_arn` | — | string | `null` | Cross-account Bedrock STS role. |

## Optional features

Each block below is omitted entirely when the feature is disabled. In CDK, leave the field out of the YAML. In Terraform, leave the variable at its default (`null` or `{}` per `variables.tf`) — usually that means commenting the block out in `terraform.tfvars`.

### Data Processing (`dataProcessingParameters` / `data_processing`)

Required if Knowledge Base is enabled. Otherwise optional.

| Field | Default | Notes |
|---|---|---|
| `inputPrefix` / `input_prefix` | `inputs` | S3 prefix for raw uploads. |
| `dataSourcePrefix` / `data_source_prefix` | `knowledge-base-data-source` | Output prefix; **must equal** the KB block's `dataSourcePrefix`. |
| `processingPrefix` / `processing_prefix` | `processing` | Intermediate storage. |
| `stagingMidfix` / `staging_midfix` | `staging` (TF) / `input` (CDK example) | Internal path component; rarely changed. |
| `transcribeMidfix` / `transcribe_midfix` | `transcribe` | For audio/video transcription. |
| `languageCode` / `language_code` | `en-US` (CDK) / `auto` (TF example) | Amazon Transcribe language. |

### Knowledge Base (`knowledgeBaseParameters` / `knowledge_base`)

Requires Data Processing.

| Field | Default | Notes |
|---|---|---|
| `chunkingStrategy.type` / `chunking_strategy` | `FIXED_SIZE` | One of `FIXED_SIZE`, `HIERARCHICAL`, `SEMANTIC`, `NONE`. |
| `chunkingStrategy.fixedChunkingProps` | `{maxTokens: 300, overlapPercentage: 20}` | Required when type is `FIXED_SIZE`. |
| `chunkingStrategy.hierarchicalChunkingProps` | `{overlapTokens: 60, maxParentTokenSize: 1500, maxChildTokenSize: 300}` | Required when type is `HIERARCHICAL`. |
| `chunkingStrategy.semanticChunkingProps` | `{bufferSize: 0, breakpointPercentileThreshold: 95, maxTokens: 300}` | Required when type is `SEMANTIC`. |
| `embeddingModel.modelId` / `embedding_model_id` | `amazon.titan-embed-text-v2:0` | Allowed: titan v2, cohere english, cohere multilingual. |
| `embeddingModel.vectorDimension` / `vector_dimension` | `1024` | Must be 256, 512, or 1024 for titan; 1024 for cohere. |
| `dataSourcePrefix` / `data_source_prefix` | `knowledge-base-data-source` | Must equal Data Processing's `dataSourcePrefix`. |
| `description` | `Knowledge Base for searching helpful information.` | Free text. |
| `vectorStoreType` / `vector_store_type` | `OPENSEARCH_SERVERLESS` | `S3_VECTORS` is dramatically cheaper for low-QPS document KBs. Recommend it unless the user needs OpenSearch features. |

### Reranking (`rerankingModels`)

Optional. CDK-only field; not exposed in current Terraform variables.

Default suggestion if the user enables it: `{Cohere Rerank 3.5: cohere.rerank-v3-5:0, Amazon Rerank 1.0: amazon.rerank-v1:0}`.

### Observability (`agentCoreObservability` / `observability`)

| Field | Default | Notes |
|---|---|---|
| `enableTransactionSearch` / `enable_transaction_search` | `false` | **Account-level X-Ray setting.** Set to `true` only if the user confirms it's not already enabled in their account, or it'll cause a deploy error. See `docs/src/troubleshooting.md`. |
| `indexingPercentage` / `indexing_percentage` | `10` | 1–100, % of traces indexed. |

When in doubt, leave `enableTransactionSearch: false`.

### Agent Runtime (`agentRuntimeConfig` / `agent_runtime_config`)

Pre-creates a Bedrock AgentCore Runtime via IaC. If omitted, users build agents through the Agent Factory UI instead.

| Field | Default | Notes |
|---|---|---|
| `modelInferenceParameters.modelId` | one of `supportedModels` | Pick a Claude / Nova model. |
| `modelInferenceParameters.parameters.temperature` | `0.7` |  |
| `modelInferenceParameters.parameters.maxTokens` / `max_tokens` | `4096` |  |
| `modelInferenceParameters.parameters.stopSequences` / `stop_sequences` | `null` |  |
| `instructions` | brief generic system prompt | Multiline; HCL uses heredoc, YAML uses `|`. |
| `tools` | `["invoke_subagent"]` for orchestrator patterns; `[]` otherwise | Names must exist in `toolRegistry`. |
| `toolParameters` / `tool_parameters` | `{}` | Tool-name-keyed dict-of-dicts. |
| `mcpServers` / `mcp_servers` | `[]` | Names must exist in `mcpServerRegistry`. |
| `conversationManager` / `conversation_manager` | `sliding_window` | One of `sliding_window`, `summarization`, `none`. |
| `description` | optional | Free text. |
| `memoryCfg.retentionDays` / `memory_config.retention_days` | omit unless user asks | 7–365. |
| `lifecycleCfg.idleRuntimeSessionTimeoutInMinutes` | `15` | Idle timeout. |
| `lifecycleCfg.maxLifetimeInHours` | `24` | Hard cap. |

### Evaluator (`evaluatorConfig` / `evaluator_config`)

| Field | Default | Notes |
|---|---|---|
| `supportedModels` / `supported_models` | same as top-level `supportedModels` | Models used for LLM-judged evaluations. |
| `passThreshold` / `pass_threshold` | `0.8` | 0.0–1.0. |
| `defaultRubrics` / `default_rubrics` | the three rubrics from `config.ts` (OutputEvaluator, TrajectoryEvaluator, InteractionsEvaluator) | Multiline. |

### Experiments (`experimentsConfig` / `experiments_config`)

Three-mode flag. Choose one:

| Mode | CDK | TF | When |
|---|---|---|---|
| Disabled | omit `experimentsConfig` | leave `experiments_config = null` | User doesn't want synthetic test generation. |
| CRUD-only | `experimentsConfig: {supportedModels: …, deployBatchInfrastructure: false}` | `experiments_config = {deploy_batch_infrastructure = false}` | User wants the UI / data model but no Batch infra (no VPC permissions). |
| Auto-VPC | `experimentsConfig: {supportedModels: …}` | `experiments_config = {}` | Default when enabled. Creates a fresh VPC. |
| Reuse VPC | `experimentsConfig: {supportedModels: …, vpcId: "vpc-…"}` | `experiments_config = {vpc_id = "vpc-…"}` | User has an existing VPC with private subnets + NAT. |

`supportedModels` is required when enabled and defaults to the same three Bedrock models as the top-level `supportedModels`.

### MCP Servers (`mcpServerRegistry` / `mcp_server_registry`)

Each entry must have **exactly one** of:
- `runtimeId` / `runtime_id` (AgentCore Runtime-hosted MCP) — also accepts optional `qualifier` (default `"DEFAULT"`).
- `gatewayId` / `gateway_id` (AgentCore Gateway-hosted MCP).
- `url` + `authType` (CDK only) — direct Streamable HTTP endpoint, `authType` is `"SIGV4"` or `"NONE"`.

Common entry fields: `name`, `description`.

### Pattern-specific registries (CDK-only optional fields)

These are only meaningful when running graph or swarm agent patterns. If the user describes a single-agent or agents-as-tools deployment, leave them out.

- `stateClassRegistry`: `[{key, label, description, fields[]}]`
- `deterministicNodeRegistry`: `[{key, label, description}]`
- `structuredOutputRegistry`: `[{key, label, description, fields[]}]`

These don't have a Terraform mirror in `variables.tf` today. If the user explicitly asks for them in TF, flag the gap rather than inventing variables.

## Inter-feature constraints (the "did you mean" rules)

| If the user enables… | Make sure… |
|---|---|
| `knowledgeBaseParameters` | `dataProcessingParameters` is also set, and the two `dataSourcePrefix` values match. |
| `toolRegistry` includes `retrieve_from_kb` | `knowledgeBaseParameters` is set. |
| `agentRuntimeConfig.tools` references a name | that name appears in `toolRegistry`. |
| `agentRuntimeConfig.mcpServers` references a name | that name appears in `mcpServerRegistry`. |
| `experimentsConfig` with `vpcId` | the VPC exists with private subnets + NAT. (Can't verify; just remind the user.) |
| `agentCoreObservability.enableTransactionSearch: true` | the user has confirmed Transaction Search is *not* already enabled at the account level. |

When you find a violation, prefer **silent auto-fix + tell the user** over **ask first**. Examples:
- User says "KB enabled" without mentioning data processing → auto-add Data Processing block with defaults, mention it in the summary.
- User lists `retrieve_from_kb` in tools but no KB → either add the KB block (if they implied a knowledge use case) or drop the tool. Pick the choice that best matches the user's intent and explain.
