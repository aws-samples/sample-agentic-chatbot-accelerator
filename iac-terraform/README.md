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
├── build/                      # Build artifacts (Lambda zips, layers)
├── scripts/                    # Build scripts
│   ├── build-layers.sh         # Builds Lambda layers
│   └── build-image.sh          # Builds and pushes Docker image to ECR
└── modules/
    ├── agent_core/             # Bedrock AgentCore runtime, ECR, DynamoDB tables
    ├── agent_core_apis/        # AgentCore lifecycle APIs (create/delete runtime)
    ├── api_tables/             # Session and favorite runtime DynamoDB tables
    ├── appsync/                # GraphQL API with Cognito authentication
    ├── authentication/         # Cognito User Pool, Identity Pool
    ├── cleanup/                # Cleanup Lambda for terraform destroy
    ├── data_processing/        # Document processing pipeline (S3, SQS, Step Functions)
    ├── genai_interface/        # Agent invocation and tool handling Lambdas
    ├── http_api_resolver/      # GraphQL resolvers for sync operations
    ├── knowledge_base/         # Bedrock Knowledge Base with OpenSearch Serverless
    ├── knowledge_base_apis/    # Knowledge Base management APIs
    ├── observability/          # X-Ray Transaction Search, CloudWatch Dashboard
    ├── shared/                 # Lambda layers, common configuration
    ├── user_interface/         # React app, S3, CloudFront distribution
    └── websocket_backend/      # Real-time messaging via SNS
```

## Prerequisites

- **AWS CLI** v2 configured with appropriate credentials
- **Terraform** >= 1.10.0
- **Docker** (for building Lambda layers and AgentCore container)
- **AWS Profile** (optional) configured in `~/.aws/credentials`

## Quick Start

1. **Copy the example configuration:**
   ```bash
   cp iac-terraform/terraform.tfvars.example iac-terraform/terraform.tfvars
   ```

2. **Edit `iac-terraform/terraform.tfvars`** with your settings:
   - Set `aws_region` and optionally `aws_profile`
   - Configure `prefix` and `environment` (e.g., `aca` and `dev`)
   - Optionally enable `data_processing` and `knowledge_base`

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
| `make tf-deploy` | Full deployment with proper sequencing (layers → ECR → image → infrastructure) |
| `make tf-deploy-auto` | Deploy with auto-approve (for CI/CD) |
| `make tf-destroy` | Destroy all infrastructure |
| `make tf-build-layers` | Build Lambda layers (auto-detects architecture) |
| `make tf-build-image` | Build and push AgentCore Docker image to ECR |
| `make tf-fmt` | Format Terraform files |
| `make tf-validate` | Validate Terraform configuration |
| `make tf-checkov` | Run Checkov security scan |
| `make tf-lint` | Full validation (format + validate + checkov) |
| `make tf-clean` | Clean build artifacts |

### Deployment Phases

The `make tf-deploy` command runs in 4 phases:

1. **Initialize** - Terraform init with provider upgrades
2. **Create ECR** - Creates ECR repository first (so image can be pushed)
3. **Build Image** - Builds and pushes AgentCore Docker image
4. **Deploy All** - Applies remaining infrastructure

## Configuration

See [`terraform.tfvars.example`](./terraform.tfvars.example) for all available configuration options:

- **Required:** `prefix`, `environment`, `aws_region`
- **Optional:** `lambda_architecture`, `aws_profile`
- **Features:**
  - `data_processing` - Document processing pipeline
  - `knowledge_base` - Bedrock Knowledge Base with vector search
  - `agent_runtime_config` - Default AgentCore runtime
  - `observability` - X-Ray and CloudWatch dashboards

## Module Responsibilities

| Module | CDK Equivalent | Purpose |
|--------|---------------|---------|
| `agent_core` | `AcaAgentCoreContainer` | ECR, DynamoDB tables, IAM roles |
| `agent_core_apis` | `AgentCoreApis` | Runtime lifecycle management |
| `authentication` | `Authentication` | Cognito User/Identity Pools |
| `appsync` | `ChatbotApi` (partial) | GraphQL API |
| `data_processing` | `DataProcessing` | Document ingestion pipeline |
| `knowledge_base` | `VectorKnowledgeBase` | Bedrock KB + OpenSearch |
| `user_interface` | `UserInterface` | React app + CloudFront |
| `cleanup` | `Cleanup` | Resource cleanup on destroy |

## Differences from CDK

- Terraform uses **native resources** instead of CDK constructs
- Lambda code is shared with CDK (`lib/*/functions/`)
- Some features may lag behind CDK implementation
- Manual sequencing required for Docker image build (handled by Makefile)
