# How To Deploy

## Pre-requisites

- AWS Account Setup:
  - AWS account with appropriate permissions
  - Permissions to CDK bootstrap the account in the deployment region (`cdk bootstrap`)
- Local Deployment:
  - Node.js (version 20 recommended)
  - Docker or Finch installed and running
  - AWS profile with appropriate authentication tokens

ℹ️ We heard that some users struggled when using finch instead of docker for deployment. If you find yourself in the same situation:

1. Open ~/.finch/finch.yaml and set rosetta: true
2. Rebuild the finch VM:
   - finch vm remove --force
   - finch vm init

While local deployment is convenient, we recognize that CodeBuild would be a better choice to avoid variance related to local deployment configurations. If local deployment does not work due to environment-specific issues, for the time being, we recommend using the EC2 deployment approach outlined below:

- Create an IAM role for EC2 deployment
- Launch an Ubuntu instance with 100GB storage
- Install Node.js, Docker, and AWS CLI
- Archive the code repository and upload to an S3 bucket in your account
- Download your stack code from S3 and run the CDK deployment commands.

## Deployment

ℹ️ For detailed CDK commands, refer to the [official documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html).

### Quick Start

1. **Bootstrap CDK** (first-time setup):
   ```bash
   cdk bootstrap --profile user-profile
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Deploy the stack**:
   ```bash
   cdk deploy --profile user-profile
   ```

### Deployment Options

#### Standard Docker Deployment
```bash
cdk deploy --profile user-profile
```

#### Finch Deployment
If using Finch instead of Docker:
```bash
CDK_DOCKER=finch cdk deploy --profile user-profile
```

#### Makefile

⚠️ Use the Makefile shortcuts to make sure that you execute required scripts before deployment:

If you want to use Docker:
```bash
make deploy PROFILE=user-profile
```

If you want to use Finch:
```bash
make deploy-finch PROFILE=user-profile
```

## CDK Configuration

The CDK stack is configured through the `SystemConfig` interface defined in [lib/shared/types.ts](../../lib/shared/types.ts). Configuration is loaded from `bin/config.yaml`, with fallback to default values in [bin/config.ts](../../bin/config.ts).

### Configuration Structure

- **prefix**: Resource naming prefix (e.g., "dev", "prod")
- **enableGeoRestrictions**: Boolean flag for geographic access restrictions
- **allowedGeoRegions**: Array of allowed geographic regions when restrictions are enabled
- **dataProcessingParameters**: *(Optional)* Configuration for data processing workflows including file prefixes and language settings. If omitted, the data processing pipeline will not be deployed.
- **knowledgeBaseParameters**: *(Optional)* Knowledge base configuration including chunking strategies (FIXED_SIZE, HIERARCHICAL, SEMANTIC, NONE), embedding models, and descriptions. If omitted, the Knowledge Base feature will not be deployed.
- **supportedModels**: Map of foundation model names to Bedrock model identifiers used by agents, with [REGION-PREFIX] placeholder for cross-region inference profiles
- **rerankingModels**: *(Optional)* Map of reranking model names to Bedrock model identifiers for improving knowledge base retrieval relevance. Supported models include Cohere Rerank 3.5 and Amazon Rerank 1.0.
- **toolRegistry**: Array of available tools with name, description, and sub-agent invocation flags
- **mcpServerRegistry**: Array of available mcp servers with name, description, and URL
- **ingestionLambdaProps**: Lambda function configuration for chatbot message ingestion including timeout in minutes and reserved concurrency (optional)
- **agentCoreObservability**: if defined, enables AgentCore observability.
- **agentRuntimeConfig**: *(Optional)* Default agent runtime configuration to deploy via CDK. If provided, an AgentCore runtime will be automatically created during deployment with the specified settings. If omitted, agent runtimes must be created manually through the Agent Factory UI.

### Example of Configuration File

```yaml
prefix: temp
enableGeoRestrictions: false
allowedGeoRegions: []
dataProcessingParameters:
    inputPrefix: inputs
    dataSourcePrefix: knowledge-base-data-source
    processingPrefix: processing
    stagingMidfix: input
    transcribeMidfix: transcribe
    languageCode: en-US
knowledgeBaseParameters:
    chunkingStrategy:
        type: HIERARCHICAL
        hierarchicalChunkingProps:
            overlapTokens: 60
            maxParentTokenSize: 1500
            maxChildTokenSize: 300
    embeddingModel:
        modelId: amazon.titan-embed-text-v2:0
        vectorDimension: 1024
    dataSourcePrefix: knowledge-base-data-source
    description: Knowledge Base that contains resources on AWS services.
supportedModels:
    Claude Sonnet 4.5: "[REGION-PREFIX].anthropic.claude-sonnet-4-5-20250929-v1:0"
    Claude Haiku 4.5: "[REGION-PREFIX].anthropic.claude-haiku-4-5-20251001-v1:0"
    Nova 2 Lite: "[REGION-PREFIX].amazon.nova-2-lite-v1:0"
    GPT OSS 20B: "openai.gpt-oss-20b-1:0"
rerankingModels:
    Cohere Rerank 3.5: cohere.rerank-v3-5:0
    Amazon Rerank 1.0: amazon.rerank-v1:0
toolRegistry:
    - name: "get_current_time"
      description: "Get the current date and time in the specified timezone. Helpful when user refers to relative time (yesterday, today, this year, now, etc.)"
      invokesSubAgent: false
    - name: "invoke_subagent"
      description: "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing"
      invokesSubAgent: true
ingestionLambdaProps:
    timeoutInMinutes: 3
    reservedConcurrency: 20
agentCoreObservability:
    enableTransactionSearch: false
    indexingPercentage: 10
mcpServerRegistry:
    - name: pubmed_mcp
      runtimeId: mcp_pubmed_server-yourid
      qualifier: DEFAULT
      description: A Model Context Protocol (MCP) server that provides tools for searching, retrieving, and exploring biomedical literature from PubMed via NCBI E-utilities.
agentRuntimeConfig:
    modelInferenceParameters:
        modelId: us.amazon.nova-2-lite-v1:0
        parameters:
            maxTokens: 2000
            temperature: 0.9
    instructions: |
        You an agent who is create at making jokes.
        Your answer should contain the joke inside <final></final> XML tags.
        If the user does not specify a topic, ask for it before generating the joke.
    description: Testing Agent CDK deployment with a joke maker
    tools: []
    toolParameters: {}
    mcpServers: []
    conversationManager: sliding_window
```

⚠️ If you have enabled already transaction search in the account where you want to deploy the stack, set `enableTransactionSearch` to `false` otherwise the deployment will fail.

### Deployment Scenarios

The Agentic Chatbot Accelerator supports flexible deployment configurations based on your use case:

#### Full Deployment (with Knowledge Base)

Include both `dataProcessingParameters` and `knowledgeBaseParameters` in your configuration to deploy the complete solution with document processing and knowledge base capabilities. This enables:
- Document upload and processing pipeline
- Knowledge base creation and management from the UI
- RAG (Retrieval-Augmented Generation) capabilities for agents

#### Minimal Deployment (without Knowledge Base)

Omit both `dataProcessingParameters` and `knowledgeBaseParameters` from your configuration to deploy a lightweight version focused only on agent management:

```yaml
prefix: dev
enableGeoRestrictions: false
allowedGeoRegions: []
# dataProcessingParameters: omitted
# knowledgeBaseParameters: omitted
supportedModels:
    Claude Haiku 3.5: "[REGION-PREFIX].anthropic.claude-3-5-haiku-20241022-v1:0"
    # ... other models
toolRegistry:
  - name: "get_current_time"
    description: "Get the current date and time"
    invokesSubAgent: false
ingestionLambdaProps:
    timeoutInMinutes: 3
```

This configuration:
- Deploys only the Agent Factory and chatbot interface
- Hides Knowledge Base-related navigation items in the UI
- Reduces deployment complexity and resource footprint
- Is ideal for use cases that don't require RAG capabilities or when using external knowledge sources via MCP servers

#### Pre-configured Agent Runtime (via CDK)

Include `agentRuntimeConfig` in your configuration to automatically deploy an agent runtime during CDK deployment:

- Eliminates manual configuration through Agent Factory UI after deployment
- Useful for standardized deployments or CI/CD pipelines
- The runtime will be automatically created when the stack is deployed
- CDK-owned runtimes are protected from cleanup handler deletion

```yaml
agentRuntimeConfig:
    modelInferenceParameters:
        modelId: "[REGION-PREFIX].anthropic.claude-3-5-haiku-20241022-v1:0"
        parameters:
            temperature: 0.5
            maxTokens: 4096
    instructions: "Your system prompt here"
    tools: ["get_current_time"]
    toolParameters: {}
    mcpServers: []
    conversationManager: "sliding_window"
    description: "Optional description"
    memoryCfg:
        retentionDays: 30
    lifecycleCfg:
        idleRuntimeSessionTimeoutInMinutes: 30
        maxLifetimeInHours: 24
```

The `agentRuntimeConfig` supports the following properties:

| Property | Required | Description |
|----------|----------|-------------|
| `modelInferenceParameters` | Yes | Model configuration including `modelId` and `parameters` (temperature, maxTokens, stopSequences) |
| `instructions` | Yes | System prompt defining the agent's behavior |
| `tools` | Yes | Array of tool names from `toolRegistry` |
| `toolParameters` | Yes | Tool-specific configuration (can be empty `{}`) |
| `mcpServers` | Yes | Array of MCP server names (can be empty `[]`) |
| `conversationManager` | Yes | Strategy: `"sliding_window"`, `"summarization"`, or `"none"` |
| `description` | No | Optional description of the runtime |
| `memoryCfg` | No | Memory persistence configuration with `retentionDays` |
| `lifecycleCfg` | No | Lifecycle settings with `idleRuntimeSessionTimeoutInMinutes` and `maxLifetimeInHours` |

## Post-Deployment Steps

1. **Note the outputs**: CDK will display important information such as the CloudFront URL where the web application is hosted
2. **Create Cognito user**: Add users to the generated User Pool
3. **Access application**: Use the CloudFront URL from deployment outputs
