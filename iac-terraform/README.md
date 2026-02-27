# Terraform Deployment (Experimental)

> ⚠️ **Note:** Terraform is an **experimental** deployment option for the Agentic Chatbot Accelerator. New features are first implemented in CDK and then ported to Terraform. For the most complete and up-to-date deployment experience, use the CDK deployment from the root directory.

## Directory Structure

```
iac-terraform/
├── main.tf                     # Root module - orchestrates all infrastructure
├── variables.tf                # Input variable definitions
├── outputs.tf                  # Stack outputs (URLs, IDs, etc.)
├── providers.tf                # AWS provider configuration
├── versions.tf                 # Terraform and provider version constraints
├── terraform.tfvars.example    # Example configuration file
├── build/                      # Build artifacts (source zips for CodeBuild)
├── scripts/                    # Legacy build scripts (optional, for local builds)
│   ├── build-layers.sh         # Builds Lambda layers locally (Docker required)
│   └── build-image.sh          # Builds Docker image locally (Docker required)
└── modules/
    ├── agent_core/             # ECR, CodeBuild for Docker images, DynamoDB tables
    ├── agent_core_apis/        # AgentCore lifecycle APIs (create/delete runtime)
    ├── api_tables/             # Session and favorite runtime DynamoDB tables
    ├── appsync/                # GraphQL API with Cognito authentication
    ├── authentication/         # Cognito User Pool, Identity Pool
    ├── cleanup/                # Cleanup Lambda for terraform destroy
    ├── data_processing/        # Document processing pipeline (S3, SQS, Step Functions)
    ├── evaluation/             # Agent evaluation framework
    ├── genai_interface/        # Agent invocation and tool handling Lambdas
    ├── http_api_resolver/      # GraphQL resolvers for sync operations
    ├── knowledge_base/         # Bedrock Knowledge Base with OpenSearch Serverless
    ├── knowledge_base_apis/    # Knowledge Base management APIs
    ├── observability/          # X-Ray Transaction Search, CloudWatch Dashboard
    ├── shared/                 # CodeBuild for Lambda layers and TypeScript builds
    ├── user_interface/         # CodeBuild for React app, S3, CloudFront distribution
    └── websocket_backend/      # Real-time messaging via SNS
```

## Prerequisites

- **AWS CLI** v2 configured with appropriate credentials
- **Terraform** >= 1.10.0
- **Node.js** >= 20 (for GraphQL codegen before deployment)
- **Docker** (optional, only for legacy local builds via `tf-build-layers` / `tf-build-image`)
- **AWS Profile** configured in `~/.aws/credentials`

## Quick Start

1. **Copy the example configuration:**
   ```bash
   cp iac-terraform/terraform.tfvars.example iac-terraform/terraform.tfvars
   ```

2. **Edit `iac-terraform/terraform.tfvars`** with your settings:
   - Set `aws_region` and optionally `aws_profile`
   - Configure `prefix` and `environment` (e.g., `aca` and `dev`)
   - Optionally configure `data_processing` and `knowledge_base`

3. **Deploy** (from the **root** directory):
   ```bash
   make tf-deploy
   ```

4. **Get outputs:**
   ```bash
   cd iac-terraform && terraform output
   ```

## Makefile Commands

> **Important:** All `make` commands must be executed from the **root** directory of the repository.

| Command | Description |
|---------|-------------|
| `make tf-init` | Initialize Terraform (download providers/modules) |
| `make tf-plan` | Preview infrastructure changes |
| `make tf-deploy` | Full deployment: runs GraphQL codegen, then Terraform. All builds (Docker images, Lambda layers, React app) are handled by CodeBuild. |
| `make tf-deploy-auto` | Deploy with auto-approve including GraphQL codegen (for CI/CD) |
| `make tf-destroy` | Destroy all infrastructure |
| `make tf-build-layers` | **Legacy:** Build Lambda layers locally (requires Docker). Normal deploys use CodeBuild. |
| `make tf-build-image` | **Legacy:** Build Docker image locally (requires Docker). Normal deploys use CodeBuild. |
| `make tf-fmt` | Format Terraform files |
| `make tf-validate` | Validate Terraform configuration |
| `make tf-checkov` | Run Checkov security scan |
| `make tf-lint` | Full validation (format + validate + checkov) |
| `make tf-clean` | Clean build artifacts |

### How Deployment Works

The `make tf-deploy` command:

1. **GraphQL Codegen** - Generates TypeScript types from AppSync schema (`npm run gen`)
2. **Copy Utilities** - Copies shared GraphQL utility to Lambda functions (`npm run copy-graphql-util`)
3. **Terraform Init** - Initializes providers with `-upgrade`
4. **Terraform Apply** - Deploys infrastructure; CodeBuild projects are triggered automatically when source changes:
   - **Docker images** (agent-core, swarm-agent-core) - Built and pushed to ECR
   - **Python Lambda layers** (boto3) - Built and uploaded to S3
   - **TypeScript Lambdas** (notify-runtime-update) - Compiled and uploaded to S3
   - **React web app** - Built and deployed to S3/CloudFront

No local Docker is required for standard deployments - all builds happen in AWS CodeBuild.

## Configuration

See [`terraform.tfvars.example`](./terraform.tfvars.example) for all available configuration options:

- **Required:** `prefix`, `environment`, `aws_region`
- **Optional:** `lambda_architecture`, `aws_profile`
- **Features:**
  - `data_processing` - Document processing pipeline
  - `knowledge_base` - Bedrock Knowledge Base with vector search
  - `agent_runtime_config` - Default AgentCore runtime
  - `observability` - X-Ray and CloudWatch dashboards
  - `evaluator_config` - Agent evaluation framework

## Module Responsibilities

| Module | CDK Equivalent | Purpose |
|--------|---------------|---------|
| `agent_core` | `AcaAgentCoreContainer` | ECR, CodeBuild for Docker images, DynamoDB tables |
| `agent_core_apis` | `AgentCoreApis` | Runtime lifecycle management |
| `authentication` | `Authentication` | Cognito User/Identity Pools |
| `appsync` | `ChatbotApi` (partial) | GraphQL API |
| `data_processing` | `DataProcessing` | Document ingestion pipeline |
| `evaluation` | `Evaluation` | Agent evaluation framework |
| `knowledge_base` | `VectorKnowledgeBase` | Bedrock KB + OpenSearch |
| `shared` | `Layer` | CodeBuild for Lambda layers and TypeScript builds |
| `user_interface` | `UserInterface` | CodeBuild for React app + CloudFront |
| `cleanup` | `Cleanup` | Resource cleanup on destroy |

## Differences from CDK

- Terraform uses **native resources** instead of CDK constructs
- Lambda code is shared with CDK (`lib/*/functions/`)
- All builds happen in **CodeBuild** rather than locally (Docker/esbuild)
- Some features may lag behind CDK implementation
