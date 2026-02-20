# Development Guide

## Overview

The Agentic Chatbot Accelerator is a full-stack web application built with AWS CDK that enables rapid deployment of agentic chatbots powered by AWS Bedrock AgentCore and AWS Strands. This guide covers the complete development workflow from setup to deployment.

## Project Structure

```
agentic-chatbot-accelerator/
├── bin/                    # CDK app entry point and configuration
│   ├── config.ts          # Default TypeScript configuration
│   ├── config.yaml        # YAML configuration override - not Git versioned
│   └── aca.ts           # CDK app entry point
├── lib/                    # CDK constructs and infrastructure code
│   ├── api/               # GraphQL API and Lambda functions
│   │   ├── functions/     # Lambda function implementations
│   │   │   ├── http-api-handler/      # Main HTTP API handler
│   │   │   ├── knowledge-base-resolver/ # KB operations (optional feature)
│   │   │   └── ...        # Other Lambda resolvers
│   │   ├── schema/        # GraphQL schema definitions
│   │   ├── tables/        # DynamoDB table constructs
│   │   ├── knowledge-base.ts # Knowledge Base API construct (optional)
│   │   └── *.ts           # Other API construct files
│   ├── user-interface/    # React frontend application
│   │   ├── react-app/     # React source code
│   │   ├── index.ts       # UI construct
│   │   └── public-website.ts # S3/CloudFront setup
│   ├── agent-core/        # AgentCore runtime infrastructure and definition
│   │   ├── docker/        # Container definitions
│   │   └── index.ts       # AgentCore construct
│   ├── authentication/    # Cognito User Pool setup
│   ├── cleanup/           # Resource cleanup functions
│   ├── data-processing/   # Document processing pipeline
│   │   ├── functions/     # Processing Lambda functions
│   │   ├── state-machines/ # Step Functions workflows
│   │   └── *.ts           # Processing constructs
│   ├── genai-interface/   # AI service integrations - used to invoke AgentCore runtimes
│   ├── knowledge-base/    # Knowledge base management
│   ├── layer/             # Lambda layers
│   ├── shared/            # Common utilities and types
│   │   ├── alpine-zip/    # Zip utilities
│   │   ├── layers/        # Shared Lambda layers
│   │   ├── types.ts       # TypeScript type definitions
│   │   └── utils.ts       # Utility functions
│   └── aca-stack.ts     # Main CDK stack
├── docs/                  # Documentation and assets
│   ├── diagrams/          # Architecture diagrams
│   ├── gifs/              # UX demonstration GIFs
│   ├── imgs/              # Documentation images
│   └── src/               # Markdown documentation
├── test/                  # CDK component tests - not implemented
├── .gitignore             # Git ignore rules
├── .pre-commit-config.yaml # Pre-commit hook configuration
├── cdk.json               # CDK configuration
├── Makefile               # Build automation
├── package.json           # Node.js dependencies
├── pyproject.toml         # Python project configuration
├── tsconfig.json          # TypeScript configuration
└── uv.lock                # Python dependency lock file
```

## Optional Features

The Agentic Chatbot Accelerator supports optional features that can be enabled or disabled via configuration. This modular architecture allows for flexible deployments based on your use case.

### Knowledge Base Feature

The Knowledge Base feature includes:
- **Data Processing Pipeline** (`lib/data-processing/`): Step Functions workflow for document processing
- **Knowledge Base Management** (`lib/knowledge-base/`): Bedrock Knowledge Base provisioning and management
- **Knowledge Base API** (`lib/api/knowledge-base.ts`): Dedicated Lambda resolver for KB operations
- **UI Components**: Navigation items and pages for document and KB management

This feature is enabled when both `knowledgeBaseParameters` and `dataProcessingParameters` are configured in `bin/config.yaml`. When disabled:
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
npm install

# Setup Python environment (optional but recommended)
make init-python-env
make install-python-packages

# Install pre-commit hooks
pre-commit install
```

### 2. Configuration

Create `bin/config.yaml` to override default settings. See [documentation on CDK deployment](./how-to-deploy.md).

### The Role of Python

Python is exclusively used to activate linters while developing Lambda functions. It is not required to create a virtual environment or install packages using `uv`.

### VSCode Configuration

If you are using VSCode as your IDE, you can use the following workspace settings:

```json
{
    "python.analysis.extraPaths": ["./lib/shared/layers/python-sdk"],
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
        "lib/shared/layers/python-sdk/tests"
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

#### Chat Interface (`lib/user-interface/react-app/src/components/chatbot/`)
- `chat.tsx`: Main chat container
- `chat-input-panel.tsx`: Message input with voice support
- `chat-message.tsx`: Message rendering with markdown support
- `sessions.tsx`: Session history management

#### Admin Interface (`lib/user-interface/react-app/src/components/admin/`)
- `agent-core-runtime-manager.tsx`: AgentCore runtime management
- `kb-manager.tsx`: Knowledge base administration
- `documents.tsx`: Document upload and processing


### GraphQL Integration

The frontend uses AWS AppSync with generated TypeScript types:

```bash
# Generate GraphQL types
npm run gen
```

### Local development

Go to `<app cloudfront URL>/aws-exports.json` and copy its content to `lib/user-interface/react-app/public/aws-exports.json`, then run `npm run dev` from the [react app folder](../../lib/user-interface/react-app).

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
