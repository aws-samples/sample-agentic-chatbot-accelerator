# Documentation

The complete documentation map for the Agentic Chatbot Accelerator. The guides are grouped to follow the agent lifecycle — deploy the harness, build and extend agents, then run, evaluate, and operate them.

## Getting Started

- [How to Deploy (CDK)](./how-to-deploy.md) — prerequisites, the three-phase `make deploy`, and deployment scenarios (full / minimal / pre-configured runtime / experiments).
- [Terraform Deployment](../../iac-terraform/README.md) — the experimental Terraform path.
- [Development Guide](./development-guide.md) — local development workflow, project structure, IDE setup, and code quality tooling.

## Building Agents

- [Agent Factory Operations](./agent-factory.md) — the GraphQL operations behind the Agent Factory (create/update/delete runtimes), by execution model.
- [Expanding the AI Tools Family](./expanding-ai-tools.md) — register MCP servers and add custom function/object tools to extend agent capabilities.
- [Agent Skills](./skills.md) — give agents on-demand access to modular instruction packages they discover and activate only when relevant.
- [Knowledge Base Management](./kb-management.md) — the document-processing pipeline and Bedrock Knowledge Base for RAG.

### Agentic Patterns

- [Single Agent](./agentic-patterns/single-agent.md) — one agent with direct access to tools, knowledge bases, and MCP servers.
- [Agents as Tools](./agentic-patterns/agents-as-tools.md) — an orchestrator that delegates to specialized sub-agents as callable tools.
- [Swarm](./agentic-patterns/swarm-agents.md) — collaborative agents that hand off conversations to each other.
- [Graph](./agentic-patterns/graph-agents.md) — agent workflows defined as directed graphs with conditional routing.

## Running & Operating

- [Agent Evaluation](./evaluation.md) — systematically test agent responses with the Strands Evaluation SDK.
- [Observability & Insights](./observability-insights.md) — X-Ray distributed tracing and CloudWatch Logs Insights queries for monitoring agents.
- [Troubleshooting](./troubleshooting.md) — common issues during development and deployment, and how to resolve them.

## Reference

- [AWS Architecture](./architecture.md) — system architecture, real-time communication, and the AWS resources deployed.
- [API Reference](./api.md) — the GraphQL API schema and operations.

---

For creating and modifying agents from your editor, see the [agent-creator Claude Code plugin](../../.claude/plugins/agent-creator/README.md). To contribute, see [CONTRIBUTING.md](../../CONTRIBUTING.md).
