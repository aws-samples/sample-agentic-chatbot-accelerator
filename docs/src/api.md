# API Reference

> [← Documentation index](./index.md)

This page documents the AppSync GraphQL API. The authoritative source for argument and return types is the [GraphQL schema](../../src/api/schema/schema.graphql) — refer to it for exact input/output shapes.

> **Authorization:** Every operation is callable over the internet and requires a user authenticated via Amazon Cognito (`@aws_cognito_user_pools`), **except** the three `publish*` mutations (`publishResponse`, `publishRuntimeUpdate`, `publishEvaluationUpdate`), which are invoked **only by backend Lambda functions** via IAM (`@aws_iam`) and are not user-callable. The tables below note only the exceptions in the **Auth** column.

> **Note:** The chat data path does **not** go through this API. The browser streams to AgentCore directly over a SigV4-signed WebSocket — including tool-step updates. AppSync is used for CRUD (sessions, agents, knowledge bases, evaluations, experiments, skills) and for runtime/evaluation status notifications via subscriptions. See [Architecture](./architecture.md).

## Chat & Messaging

User messages are sent to the agent over the direct WebSocket, not through this API (there is no `sendQuery` mutation — it was removed when chat moved to the direct WebSocket). The operations below cover the AppSync side-channel that delivers responses and tool-action descriptions back to the browser, plus feedback.

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| publishResponse | Mutation | Publish response tokens and the final agent answer to the client | Lambda only | The browser subscribes via `receiveMessages` |
| receiveMessages | Subscription | Subscribe to `publishResponse` for a session | | |
| publishFeedback | Mutation | Publish a user's feedback on an agent-generated response | | Thumbs up/down and free-text feedback |

## Sessions

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listSessions | Query | List all of the user's chatbot sessions | | |
| getSession | Query | Get a specific session by session id | | Allows reloading a conversation to view or continue it |
| deleteUserSessions | Mutation | Delete all of the user's sessions | | |
| deleteSession | Mutation | Delete a specific user session | | |
| renameSession | Mutation | Modify a session title | | A session title defaults to the first 100 characters of the first user message |
| saveToolActions | Mutation | Save tool actions for a specific message in a session | | Persists a user-friendly description of the agent's tool invocations to the session history |
| saveVoiceSession | Mutation | Persist a voice-to-voice conversation's history to a session | | Used by Nova Sonic voice sessions to save the transcript and runtime/endpoint |
| updateMessageExecutionTime | Mutation | Update the execution time for a message in a session | | |

## Knowledge Bases & Documents

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listKnowledgeBases | Query | List available Bedrock Knowledge Bases | | Filters on AWS tags: stack name and environment |
| createKnowledgeBase | Mutation | Create a new Bedrock Knowledge Base from the application | | |
| deleteKnowledgeBase | Mutation | Delete an existing Bedrock Knowledge Base | | |
| listDataSources | Query | List data sources associated with a Knowledge Base | | |
| createDataSource | Mutation | Create a new S3 data source and attach it to a Knowledge Base | | |
| deleteDataSource | Mutation | Remove an S3 data source from a Knowledge Base | | |
| getInputPrefix | Query | Get the raw input prefix associated with a data source | | |
| syncKnowledgeBase | Mutation | Synchronize a Knowledge Base | | A fallback mechanism — Knowledge Base synchronization normally runs automatically |
| listDocuments | Query | List documents in a data source | | |
| deleteDocument | Mutation | Delete a document from a data source | | |
| getDocumentMetadata | Query | Get the metadata associated with a document | | |
| updateMetadata | Mutation | Update the metadata of a single document | | |
| batchUpdateMetadata | Mutation | Update the metadata of a set of documents | | Used to upload metadata as JSONL |
| getPresignedUrl | Query | Get an S3 object presigned URL | | Used to display the document behind a knowledge-base reference |
| checkOnProcessStarted | Query | Check whether document processing has started for a set of S3 objects | | Polled after the user uploads documents through the UI |
| checkOnProcessCompleted | Query | Check whether document processing has completed for a set of S3 objects | | Polled after the user uploads documents through the UI |
| checkOnDocumentsRemoved | Query | Check whether documents have been removed from the doc-processing state table | | Polled after the user deletes documents through the UI |
| checkOnSyncInProgress | Query | Check whether a data-source sync is currently in progress | | Polled after the user adds/deletes documents through the UI |

## Agent Runtimes (Agent Factory)

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listRuntimeAgents | Query | List AgentCore runtimes | | Filters on AWS tags: stack name and environment |
| createAgentCoreRuntime | Mutation | Create an AgentCore runtime | | See [Agent Factory Operations](./agent-factory.md) for the `architectureType` → config-schema mapping |
| tagAgentCoreRuntime | Mutation | Tag an AgentCore runtime version with a label | | Tagging a version is what creates an endpoint (qualifier) |
| deleteAgentRuntime | Mutation | Delete an AgentCore runtime | | |
| deleteAgentRuntimeEndpoints | Mutation | Delete an AgentCore runtime endpoint | | |
| listAgentVersions | Query | List all versions of an AgentCore runtime | | |
| listAgentEndpoints | Query | List all endpoints (qualifiers) of an AgentCore runtime | | |
| getRuntimeConfigurationByVersion | Query | Get the configuration for a specific runtime version | | Configuration = model, instructions, tools, knowledge bases |
| getRuntimeConfigurationByQualifier | Query | Get the configuration for a specific endpoint label | | Qualifier = endpoint name |
| getDefaultRuntimeConfiguration | Query | Get the configuration for the DEFAULT endpoint | | DEFAULT qualifier points to the latest version |
| getFavoriteRuntime | Query | Get the user's favorite AgentCore runtime and endpoint | | The chatbot initializes with the favorite runtime if set |
| updateFavoriteRuntime | Mutation | Update the user's favorite AgentCore runtime and endpoint | | |
| resetFavoriteRuntime | Mutation | Remove the favorite endpoint for the user | | |
| publishRuntimeUpdate | Mutation | Notify on an AgentCore runtime update | Lambda only | Used for both delete-runtime and delete-endpoints |
| receiveUpdateNotification | Subscription | Receive AgentCore runtime updates | | |

## Tools, MCP Servers & Building Blocks

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listAvailableTools | Query | List the AI tools that can be attached to an agent | | |
| listAvailableMcpServers | Query | List the MCP servers that can be attached to an agent | | |
| registerMcpServer | Mutation | Register an MCP server | | |
| deleteMcpServer | Mutation | Delete an MCP server | | |
| listAvailableStateClasses | Query | List the state classes available to swarm/graph agents | | |
| listAvailableDeterministicNodes | Query | List the deterministic nodes available to graph agents | | |

## Skills

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listSkills | Query | List all registered agent skills | | See [Agent Skills](./skills.md) |
| getSkillContent | Query | Get a skill's content by name | | |
| createSkill | Mutation | Create a new skill | | |
| updateSkill | Mutation | Update an existing skill's description or content | | |
| deleteSkill | Mutation | Delete a skill | | |
| listSkillResources | Query | List the resource files attached to a skill | | |
| getSkillResource | Query | Get a single skill resource file by path | | |
| uploadSkillResource | Mutation | Upload a resource file to a skill | | |
| deleteSkillResource | Mutation | Delete a skill resource file by path | | |

## Evaluations

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listEvaluators | Query | List all evaluation configurations | | Returns evaluator metadata including status, progress, and pass rates |
| getEvaluator | Query | Get a specific evaluator by ID | | Includes detailed results when the evaluation is completed |
| createEvaluator | Mutation | Create a new evaluation configuration | | Defines test cases, evaluator type, and target agent |
| deleteEvaluator | Mutation | Delete an evaluator and its results | | Removes all associated S3 results |
| runEvaluation | Mutation | Start an evaluation run | | Queues test cases to SQS for processing |
| publishEvaluationUpdate | Mutation | Publish an evaluation status update | Lambda only | |
| receiveEvaluationUpdate | Subscription | Receive evaluation status updates | | Subscribes to `publishEvaluationUpdate` |

## Experiments

| Operation | Type | Functionality | Auth | Comments |
|-----------|------|---------------|------|----------|
| listExperiments | Query | List all experiments | | |
| getExperiment | Query | Get a specific experiment by ID | | |
| getExperimentPresignedUrl | Query | Get a presigned URL for experiment S3 objects | | |
| createExperiment | Mutation | Create a new experiment | | |
| updateExperiment | Mutation | Update an existing experiment | | |
| deleteExperiment | Mutation | Delete an experiment | | |
| runExperiment | Mutation | Run an experiment | | |
