# AWS Architecture

![Architecture](../imgs/architecture.png)

## Frontend

| Resource | Role |
|----------|------|
| Amazon CloudFront | CDN distribution for global low-latency access |
| Amazon S3 (Website Bucket) | Static React application hosting |
| Amazon S3 (Website Logs) | Access logs for the website bucket |
| Amazon S3 (CF Distribution Logs) | CloudFront access logs |

## Authentication

| Resource | Role |
|----------|------|
| Amazon Cognito User Pool | User identity and authentication |
| Amazon Cognito Identity Pool | Temporary AWS credentials for authenticated users (used to sign presigned WebSocket URLs for direct AgentCore access) |

## API Layer

| Resource | Role |
|----------|------|
| AWS AppSync (GraphQL API) | Primary API for CRUD operations (sessions, agent config, evaluations) and tool-action subscription side-channel |
| λ HTTP API Resolver | Handles REST-like queries (session history, feedback, runtime management) |
| λ Outgoing Message Handler | Delivers AI-rephrased tool descriptions to browser via AppSync subscriptions |
| Step Function — Create Runtime | Orchestrates agent runtime creation (validate config → create AgentCore runtime → tag endpoint) |
| Step Function — Delete Runtime | Orchestrates agent runtime deletion (delete endpoint → delete runtime → cleanup) |
| DynamoDB — Chatbot Sessions | Conversation history storage |
| DynamoDB — Evaluators | Evaluation configurations and results |
| DynamoDB — Template Schemas | Agent configuration schemas |

## Messaging Bus (Tool Action Side-Channel)

| Resource | Role |
|----------|------|
| SNS Topic — chatMessages | Publishes tool action descriptions from AgentCore container to Outgoing Message Handler |
| SNS Topic — agentTools | Distributes tool invocation notifications to the Agent Tools Handler for AI-rephrasing |

> **Note:** The main chat/voice data path does **not** flow through SNS. It goes directly from the browser to the AgentCore container via presigned WebSocket. The SNS topics are only used for the tool-action description side-channel.

## GenAI Interface

| Resource | Role |
|----------|------|
| λ Agent Tools Handler | Receives tool invocations from SNS, calls a fast model (Mistral) to generate user-friendly descriptions, publishes to chatMessages topic |
| λ Notify Runtime Update | Notifies the frontend via AppSync when runtime status changes (creation complete, deletion complete) |

## Agent Core Infrastructure

| Resource | Role |
|----------|------|
| Amazon Bedrock AgentCore Runtime | Managed runtime hosting Docker containers as agent endpoints |
| FastAPI Application (in container) | WebSocket server exposing `/ws` (text + voice) and `/ws/voice` endpoints, plus `/invocations` for agent-to-agent calls |
| ECR — Single Agent | Container image for single-agent pattern (Strands Agents) |
| ECR — Agents-as-Tools | Container image for orchestrator + sub-agents pattern |
| ECR — Swarm Agent | Container image for swarm multi-agent pattern |
| ECR — Graph Agent | Container image for directed-graph agent pattern |
| IAM Execution Role | Runtime permissions for Bedrock, DynamoDB, SNS, SSM |
| DynamoDB — Runtime Config | Agent configuration (model, instructions, tools, parameters) |
| DynamoDB — Tool Registry | Custom tool definitions |
| DynamoDB — MCP Server Registry | Registered MCP servers (endpoints, auth) |
| DynamoDB — State Class Registry | Swarm/graph state class configurations |
| DynamoDB — Structured Outputs | Structured output field specifications |
| DynamoDB — Agent Summary | Agent metadata and endpoint status |
| DynamoDB — Deterministic Nodes | Graph agent deterministic node configurations |
| SSM Parameters | Runtime environment configuration (account ID, region, table names) |

## Real-Time Communication (Direct WebSocket)

The browser connects **directly** to the AgentCore container — no API Gateway or proxy Lambda in the data path.

```
Browser → SigV4 presigned URL → wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/ws → FastAPI /ws endpoint
```

| Mode | Protocol | Description |
|------|----------|-------------|
| **Text** | WebSocket `/ws` | Client sends `text_input`, receives `text_token` + `final_response` |
| **Voice** | WebSocket `/ws` with `voice_init` | Client sends `voice_init` to switch to BidiAgent mode; bidirectional audio streaming via Nova Sonic |
| **Agent-to-Agent** | HTTP POST `/invocations` | SSE stream for orchestrator → sub-agent delegation |

## Amazon Bedrock — Foundation Models

| Model | Use Case |
|-------|----------|
| Claude Opus 4.7 | Complex reasoning, high-quality responses |
| Claude Sonnet 4.6 | Balanced performance/cost, extended thinking |
| Claude Haiku 4.5 | Fast responses, cost-efficient |
| Amazon Nova 2 Lite | Fast text inference |
| Amazon Nova Sonic | Voice-to-voice bidirectional streaming (BidiAgent) |
| Mistral Ministral 3 | Tool-action description generation (cheap, fast) |

## Data Processing *(optional)*

Enabled when `knowledgeBaseParameters` and `dataProcessingParameters` are configured.

| Resource | Role |
|----------|------|
| Amazon S3 (Document Bucket) | Document upload storage |
| Step Function — Document Processing | Orchestrates chunking, embedding, and ingestion into Knowledge Base |
| Amazon Bedrock Knowledge Base | Semantic/hybrid search for RAG. Backend selectable via `vectorStoreType`: Amazon OpenSearch Serverless (default, supports hybrid search) or Amazon S3 Vectors (cheaper, semantic-only) — see [Vector Store Backend](./kb-management.md#vector-store-backend) |
| Lambda functions | Document processing steps (chunking, metadata extraction) |

## Observability & Monitoring

| Resource | Role |
|----------|------|
| AWS X-Ray (Transaction Search) | Distributed tracing for agent invocations |
| CloudWatch Dashboard | Operational metrics visualization |
| CloudWatch Alarms (All Lambdas) | Error rate and duration alerts |
| SNS — Lambda Alarms | Alarm notification delivery |
| CloudTrail (DynamoDB Events) | Audit trail for data access |
| Amazon S3 (CloudTrail Logs) | CloudTrail log storage |

## Cleanup

| Resource | Role |
|----------|------|
| λ Cleanup Handler | Removes expired sessions, orphaned resources on stack deletion |
