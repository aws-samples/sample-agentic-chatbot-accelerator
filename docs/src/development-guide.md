# Development Guide

## Overview

The Agentic Chatbot Accelerator is a full-stack web application built with AWS CDK that enables rapid deployment of agentic chatbots powered by AWS Bedrock AgentCore and AWS Strands. This guide covers the complete development workflow from setup to deployment.

> **Looking to contribute?** For contribution guidelines — including pull request process, branching strategy, coding standards, and code of conduct — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Project Structure

```
agentic-chatbot-accelerator/
├── src/                        # Shared runtime code (Lambda, Docker, React)
│   ├── agent-core/             # AgentCore runtime containers
│   │   ├── docker/             # Single agent container
│   │   ├── docker-agents-as-tools/ # Agents-as-tools container
│   │   ├── docker-graph/       # Graph agent container
│   │   ├── docker-swarm/       # Swarm agent container
│   │   ├── functions/          # AgentCore Lambda functions
│   │   └── shared/             # Shared agent utilities
│   ├── api/                    # GraphQL API
│   │   ├── functions/          # Lambda resolvers
│   │   ├── schema/             # GraphQL schema definitions
│   │   └── state-machines/     # Step Functions for agent lifecycle
│   ├── user-interface/         # React frontend application
│   │   └── react-app/          # React source code
│   ├── data-processing/        # Document processing pipeline (optional)
│   │   ├── functions/          # Processing Lambda functions
│   │   └── state-machines/     # Step Functions workflows
│   ├── genai-interface/        # AI service integrations (AgentCore invocation)
│   ├── knowledge-base/         # Knowledge base management (optional)
│   ├── cleanup/                # Resource cleanup functions
│   ├── experiments-batch/      # Batch experiment runner
│   └── shared/                 # Common utilities and Lambda layers
│       └── layers/             # Shared Lambda layers (Python SDK)
├── iac-cdk/                    # CDK infrastructure-as-code
│   ├── bin/                    # CDK app entry point and configuration
│   │   ├── aca.ts              # CDK app entry point
│   │   ├── config.ts           # Default TypeScript configuration
│   │   └── config.yaml         # YAML configuration override (not Git versioned)
│   ├── lib/                    # CDK constructs
│   │   ├── aca-stack.ts        # Main CDK stack
│   │   ├── agent-core/         # AgentCore construct
│   │   ├── api/                # API constructs (HTTP, WebSocket, AppSync)
│   │   ├── authentication/     # Cognito User Pool setup
│   │   ├── cleanup/            # Cleanup construct
│   │   ├── data-processing/    # Document processing construct (optional)
│   │   ├── experiments-batch/  # Experiments construct
│   │   ├── genai-interface/    # GenAI interface construct
│   │   ├── knowledge-base/     # Knowledge base construct (optional)
│   │   ├── layer/              # Lambda layers construct
│   │   ├── observability/      # Observability construct
│   │   ├── shared/             # Shared utilities and types
│   │   └── user-interface/     # Frontend construct (S3/CloudFront)
│   └── test/                   # CDK tests
├── iac-terraform/              # Terraform infrastructure-as-code
│   ├── modules/                # Terraform modules (mirrors CDK constructs)
│   └── scripts/                # Build scripts
├── docs/                       # Documentation and assets
│   ├── diagrams/               # Architecture diagrams
│   ├── imgs/                   # Documentation images
│   └── src/                    # Markdown documentation
├── .pre-commit-config.yaml     # Pre-commit hook configuration
├── Makefile                    # Build automation
├── pyproject.toml              # Python project configuration (for dev only)
└── uv.lock                     # Python dependency lock file
```

## Optional Features

The Agentic Chatbot Accelerator supports optional features that can be enabled or disabled via configuration. This modular architecture allows for flexible deployments based on your use case.

### Knowledge Base Feature

The Knowledge Base feature includes:
- **Data Processing Pipeline** (`src/data-processing/` (CDK construct: `iac-cdk/lib/data-processing/`)): Step Functions workflow for document processing
- **Knowledge Base Management** (`src/knowledge-base/` (CDK construct: `iac-cdk/lib/knowledge-base/`)): Bedrock Knowledge Base provisioning and management
- **Knowledge Base API** (`iac-cdk/lib/api/knowledge-base.ts`): Dedicated Lambda resolver for KB operations
- **UI Components**: Navigation items and pages for document and KB management

This feature is enabled when both `knowledgeBaseParameters` and `dataProcessingParameters` are configured in `iac-cdk/bin/config.yaml`. When disabled:
- Related infrastructure is not deployed
- UI navigation items are hidden
- Agent runtime wizard skips KB configuration step

See [How to Deploy - Deployment Scenarios](./how-to-deploy.md#deployment-scenarios) for configuration examples.

## Development Setup

### 1. Environment Setup

```bash
# Clone repository
git clone <repository-url>
cd agentic-chatbot-accelerator

# Install Node.js dependencies
cd iac-cdk && npm install

# Setup Python environment (optional but recommended)
make init-python-env
make install-python-packages

# Install pre-commit hooks
GIT_CONFIG=/dev/null pre-commit install
```

### 2. Configuration

Create `iac-cdk/bin/config.yaml` to override default settings. See [documentation on CDK deployment](./how-to-deploy.md).

### The Role of Python

Python is exclusively used to activate linters while developing Lambda functions. It is not required to create a virtual environment or install packages using `uv`.

### VSCode Configuration

If you are using VSCode as your IDE, you can use the following workspace settings:

```json
{
    "python.analysis.extraPaths": ["./src/shared/layers/python-sdk"],
    "[python]": {
        "editor.formatOnSave": false,
        "editor.defaultFormatter": "ms-python.black-formatter"
    },
    "[typescript]": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
    },
    "[javascript]": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
    },
    "[typescriptreact]": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
    },
    "isort.args":["--profile", "black"],
    "python.testing.pytestArgs": [
        "src/shared/layers/python-sdk/tests"
    ],
    "python.testing.unittestEnabled": false,
    "python.testing.pytestEnabled": true,
    "workbench.colorTheme": "Default Dark Modern"
}
```

## Frontend Development

### Technology Stack
- **React 18** with TypeScript
- **Vite** for build tooling
- **AWS Amplify** for AWS service integration
- **Cloudscape Design System** for UI components
- **React Router** for navigation

### Key Components

#### Chat Interface (`src/user-interface/react-app/src/components/chatbot/`)
- `chat.tsx`: Main chat container
- `chat-input-panel.tsx`: Message input with voice support
- `chat-message.tsx`: Message rendering with markdown support
- `sessions.tsx`: Session history management

#### Admin Interface (`src/user-interface/react-app/src/components/admin/`)
- `agent-core-runtime-manager.tsx`: AgentCore runtime management
- `kb-manager.tsx`: Knowledge base administration
- `documents.tsx`: Document upload and processing


### GraphQL Integration

The frontend uses AWS AppSync with generated TypeScript types:

```bash
# From the iac-cdk/ directory
npm run gen
```

### Local development

Go to `<app cloudfront URL>/aws-exports.json` and copy its content to `src/user-interface/react-app/public/aws-exports.json`, then run `npm run dev` from the [react app folder](../../src/user-interface/react-app).

If you get a CDK deployment error after changing frontend code, you might want to run `npm run build:dev` from the react app folder to debug more easily. Note that running `npm run build:dev` will overwrite the `aws-exports.json` file, and you will need to populate it again.

## Code Quality

### Pre-commit Hooks

The following quality hooks will automatically run on commit:

- Code formatting (Black, Prettier)
- Linting (Ruff, ESLint)
- Type checking

ASH needs to be manually executed as it can take time to run the automated security scan. We suggest running ASH scans only before opening pull requests, and on repositories that only contain remote changes (not the `cdk.out` folder). Run the following command to execute ASH:

```bash
make run-ash
```
