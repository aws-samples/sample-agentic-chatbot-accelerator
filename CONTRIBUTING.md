# Contributing to the Agentic Chatbot Accelerator

Thank you for your interest in contributing to the Agentic Chatbot Accelerator! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Contributing to the Agentic Chatbot Accelerator](#contributing-to-the-agentic-chatbot-accelerator)
  - [Table of Contents](#table-of-contents)
  - [Code of Conduct](#code-of-conduct)
  - [Reporting Bugs/Feature Requests](#reporting-bugsfeature-requests)
  - [Contributing via Pull Requests](#contributing-via-pull-requests)
  - [Finding contributions to work on](#finding-contributions-to-work-on)
  - [Use of AI Coding Assistants](#use-of-ai-coding-assistants)
  - [Project Principles](#project-principles)
  - [Getting Started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Development Environment Setup](#development-environment-setup)
    - [Project Structure](#project-structure)
  - [Development Workflow](#development-workflow)
    - [Branching Strategy](#branching-strategy)
    - [Making Changes](#making-changes)
    - [Code Quality](#code-quality)
    - [Testing Your Changes](#testing-your-changes)
  - [Contribution Types](#contribution-types)
    - [Code Contributions](#code-contributions)
    - [Documentation Contributions](#documentation-contributions)
    - [Tool Extensions](#tool-extensions)
    - [Bug Fixes](#bug-fixes)
  - [Coding Standards](#coding-standards)
    - [Python](#python)
    - [TypeScript/JavaScript](#typescriptjavascript)
    - [React](#react)
    - [General](#general)
  - [Documentation](#documentation)
  - [Reporting Bugs and Feature Requests](#reporting-bugs-and-feature-requests)
  - [Security](#security)

---

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.

## Use of AI Coding Assistants

Use of AI coding assistants (Kiro, Cline, GitHub Copilot, etc.) is encouraged when contributing to this project. However, **contributors must be able to explain every line of code that AI generated, without the assistance of AI**. Take time to understand what the AI produces before accepting suggestions.

This guideline ensures:
- Code quality and maintainability
- Contributors can effectively review and debug their contributions
- Knowledge transfer during code reviews

## Project Principles

Contributions should align with the following principles:

1. **AWS-Native Architecture**: The accelerator is built on AWS services (Bedrock AgentCore, AWS Strands, CDK). Contributions should leverage AWS services appropriately and follow AWS best practices.

2. **Modular & Optional Features**: The architecture supports flexible deployments. For example, the Knowledge Base feature is optional and can be disabled. New features should consider whether they belong in the core or as optional modules.

3. **Documentation-Driven**: This project emphasizes comprehensive documentation. Code contributions should be accompanied by appropriate documentation updates.

4. **Infrastructure as Code**: All infrastructure is defined using AWS CDK with TypeScript. Configuration is managed through YAML files with sensible defaults.

5. **Security First**: Security is paramount. All contributions must pass security scans and follow AWS security best practices.

## Getting Started

### Prerequisites

Before contributing, ensure you have the following installed:

- **Node.js** (version 20 recommended)
- **Docker** or **Finch** (for container builds)
- **AWS CLI** (configured with appropriate credentials)
- **Python 3.11+** or higher (for Lambda development and linting)
- **Git**

### Development Environment Setup

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/<your-username>/agentic-chatbot-accelerator.git     # TODO update with the correct URL
   cd agentic-chatbot-accelerator
   ```

2. **Install Node.js Dependencies**:
   ```bash
   npm install
   ```

3. **Set Up Python Environment** (optional but recommended for Lambda development):
   ```bash
   make init-python-env
   make install-python-packages
   ```

4. **Install Pre-commit Hooks**:
   ```bash
   pre-commit install
   ```

### Project Structure

Familiarize yourself with the project structure:

```
agentic-chatbot-accelerator/
├── bin/                    # CDK app entry point and configuration
│   ├── config.ts          # Default TypeScript configuration
│   ├── config.yaml        # YAML configuration override (not Git versioned)
│   └── aca.ts             # CDK app entry point
├── lib/                    # CDK constructs and infrastructure code
│   ├── api/               # GraphQL API and Lambda functions
│   ├── agent-core/        # AgentCore runtime infrastructure
│   ├── user-interface/    # React frontend application
│   ├── data-processing/   # Document processing pipeline (optional feature)
│   ├── knowledge-base/    # Knowledge base management (optional feature)
│   ├── genai-interface/   # AI service integrations
│   ├── authentication/    # Cognito User Pool setup
│   ├── cleanup/           # Resource cleanup functions
│   ├── shared/            # Common utilities, types, and Lambda layers
│   └── aca-stack.ts       # Main CDK stack
├── docs/                   # Documentation
│   ├── src/               # Markdown documentation files
│   ├── imgs/              # Documentation images
│   └── gifs/              # UX demonstration GIFs
└── test/                   # CDK component tests
```

**Key Documentation Files**:
- [Development Guide](./docs/src/development-guide.md) - Detailed development setup
- [How to Deploy](./docs/src/how-to-deploy.md) - Deployment instructions and configuration
- [API Reference](./docs/src/api.md) - GraphQL API documentation
- [Expanding AI Tools](./docs/src/expanding-ai-tools.md) - Guide for adding custom tools
- [Token Streaming Architecture](./docs/src/token-streaming-architecture.md) - Message flow architecture

## Development Workflow

### Branching Strategy

1. Create a branch from `main` for your work:
   ```bash
   git checkout -b <type>/<description>
   ```

   Use prefixes to indicate the type of change:
   - `feature/` - New features
   - `fix/` - Bug fixes
   - `docs/` - Documentation updates
   - `refactor/` - Code refactoring
   - `test/` - Test additions or modifications

2. Keep your branch up to date with `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   ```

### Making Changes

1. **Keep changes focused** on a single issue or feature
2. **Write/update tests** as necessary
3. **Update documentation** for any user-facing changes
4. **Follow existing patterns** in the codebase

### Code Quality

The following quality checks run automatically via pre-commit hooks:

- **Python**: Black (formatting), Ruff (linting), isort (import sorting)
- **TypeScript/JavaScript**: ESLint, Prettier
- **General**: Trailing whitespace, end-of-file fixes, YAML validation

Run quality checks manually:
```bash
# Run all pre-commit hooks
make precommit-run
```

### Testing Your Changes

1. **Local Linting and Formatting**:
   ```bash
   make precommit-run
   ```

2. **Frontend Testing**:
   ```bash
   cd lib/user-interface/react-app
   npm run lint
   npm run build:dev
   ```

3. **CDK Synthesis** (validates infrastructure code):
   ```bash
   npx cdk synth
   ```

4. **Security Scan** (required before opening a pull request):
   ```bash
   make run-ash
   ```

5. **Local Frontend Development**:
   - Deploy the stack first to get the CloudFront URL
   - Copy `<cloudfront-url>/aws-exports.json` to `lib/user-interface/react-app/public/aws-exports.json`
   - Run `npm run dev` from the react-app folder

## Contribution Types

### Code Contributions

- **Infrastructure (CDK)**: Modifications to `lib/` directory constructs
- **Lambda Functions**: Python handlers in `lib/*/functions/`
- **Frontend (React)**: Components in `lib/user-interface/react-app/src/`
- **Agent Runtime**: Docker container and Python code in `lib/agent-core/docker/`

### Documentation Contributions

- Add or update documentation in `docs/src/`
- Include code snippets where helpful
- Keep documentation in sync with code changes

### Tool Extensions

Follow the [Expanding AI Tools](./docs/src/expanding-ai-tools.md) guide to add:
- Custom function-based tools
- Object-based tools with configuration
- MCP server integrations

### Bug Fixes

- Reference the related issue in your PR
- Include steps to reproduce (if not in the issue)
- Add regression tests where applicable

## Coding Standards

### Python

- Follow [PEP 8](https://peps.python.org/pep-0008/) style guidelines
- Use type hints for function signatures
- Format with Black (line length: 120)
- Lint with Ruff
- Use AWS Lambda Powertools for logging and tracing

### TypeScript/JavaScript

- Follow the ESLint configuration in the project
- Format with Prettier
- Use TypeScript for new code where possible
- Follow CDK best practices for infrastructure code

### React

- Use functional components with hooks
- Follow Cloudscape Design System patterns
- Keep components focused and reusable

### General

- **Commit Messages**: Write clear, descriptive messages
  - Use imperative mood ("Add feature" not "Added feature")
  - Reference issues where applicable
- **Naming**: Use descriptive names for variables, functions, and files
- **Comments**: Explain "why" not "what" in comments

## Documentation

- Update `README.md` when adding significant features
- Add detailed documentation to `docs/src/` for:
  - New features or capabilities
  - Architecture changes
  - Configuration options
- Include diagrams for complex architectures (store in `docs/diagrams/`)
- Add GIFs for UX demonstrations (store in `docs/gifs/`)

## Reporting Bugs and Feature Requests

We welcome bug reports and feature requests through GitHub Issues.

When reporting a bug, please include:
- Description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, etc.)
- Relevant logs or screenshots

When requesting a feature, please include:
- Use case description
- Proposed solution (if any)
- Alternatives considered

## Security

Security is critical for this project. Before submitting a pull request:

1. **Run ASH (Automated Security Helper)**:
   ```bash
   make run-ash
   ```

2. **Review Security-Sensitive Areas**:
   - IAM policies and permissions: follow the principle of least privilege by granting only the minimum permissions required
   - Cognito configuration
   - GraphQL resolvers and authorization
   - Lambda function permissions
   - S3 bucket policies

3. **Report Security Vulnerabilities**:
   - Do NOT open public issues for security vulnerabilities
   - Follow [AWS Vulnerability Reporting](https://aws.amazon.com/security/vulnerability-reporting/)

---

Thank you for contributing to the Agentic Chatbot Accelerator!
