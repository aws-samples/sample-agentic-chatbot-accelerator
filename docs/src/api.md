# API Reference

The following table documents the [GraphQL API schema](../../lib/api/schema/schema.graphql).

| FieldName | Type | Functionality | Callable from Internet | Authorized Callers | Comments |
|-----------|------|---------------|------------------------|-------------------|----------|
| sendQuery | Mutation | Send user message to the backend for an agent runtime to process | Yes | User authenticated via Cognito | Fire and forget approach - the client sends the query and subscribes to receive response |
| publishResponse | Mutation | Publish to the client the tokens and the final agent answer | No | Lambda function |  |
| receiveMessages | Subscription | Subscription on publishResponse | Yes | User authenticated via Cognito |  |
| listSessions | Query | List all user's chatbot sessions | Yes | User authenticated via Cognito |  |
| getSession | Query | Get a specific user's session by session id | Yes | User authenticated via Cognito | Allows to reload a conversation to visualize or continue it |
| deleteUserSessions | Mutation | Delete all the user sessions | Yes | User authenticated via Cognito |  |
| deleteSession | Mutation | Delete a specific user session | Yes | User authenticated via Cognito |  |
| renameSession | Mutation | Modify a session title | Yes | User authenticated via Cognito | By default, a session title is composed of the first 100 characters of the first user message |
| saveToolActions | Mutation | Save tool actions for a specific message in a session | Yes | User authenticated via Cognito | Persists user friendly description of the agent's tool invocations to the session history |
| publishFeedback | Mutation | Publish user's feedback on an agent generated response | Yes | User authenticated via Cognito | Thumbs up/down and free-text form feedback |
| getPresignedUrl | Query | Get S3 object presigned URL | Yes | User authenticated via Cognito | Used to display the document that corresponds to a reference if the agent is using a knowledge base as data source |
| listKnowledgeBases | Query | List available Bedrock Knowledge Bases | Yes | User authenticated via Cognito | This filters on AWS tags: stack name and environment |
| listDataSources | Query | List data sources associated with a Bedrock Knowledge Base | Yes | User authenticated via Cognito |  |
| listDocuments | Query | List documents in a data source | Yes | User authenticated via Cognito |  |
| getInputPrefix | Query | Get the raw input prefix associated with a knowledge base data source | Yes | User authenticated via Cognito |  |
| checkOnProcessStarted | Query | Check if document processing has started for a given set of S3 objects. | Yes | User authenticated via Cognito | Used when user uploads documents through the UI. This could potentially be refactored with a mutation/subscription pattern |
| checkOnProcessCompleted | Query | Check if document processing has completed for a given set of S3 objects. | Yes | User authenticated via Cognito | Used when user uploads documents through the UI. This could potentially be refactored with a mutation/subscription pattern. |
| checkOnDocumentsRemoved | Query | Check if documents have been removed from DynamoDB that stores the doc processing states | Yes | User authenticated via Cognito | Used when user deletes documents through the UI. This could potentially be refactored with a mutation/subscription pattern. |
| checkOnSyncInProgress | Query | Check if a knowledge base data source sync is currently in progress. | Yes | User authenticated via Cognito | Used when user adds/deletes documents through the UI. This could potentially be refactored with a mutation/subscription pattern. |
| deleteDocument | Mutation | Delete a document from a data source | Yes | User authenticated via Cognito |  |
| createKnowledgeBase | Mutation | Create a new Bedrock Knowledge Base from the application | Yes | User authenticated via Cognito |  |
| deleteKnowledgeBase | Mutation | Delete an existing Bedrock Knowledge Base from the application | Yes | User authenticated via Cognito |  |
| createDataSource | Mutation | Create a new S3 data source and attach it to an existing Bedrock Knowledge Base | Yes | User authenticated via Cognito |  |
| deleteDataSource | Mutation | Remove an existing S3 data source from a Bedrock Knowledge Base | Yes | User authenticated via Cognito |  |
| syncKnowledgeBase | Mutation | Synchronize a Bedrock Knowledge Base | Yes | User authenticated via Cognito | Used a fallback mechanism because Knowledge Base synchronization is automatically done. |
| getDocumentMetadata | Query | Get the metadata associated with a document | Yes | User authenticated via Cognito |  |
| updateMetadata | Mutation | Update the metadata of a single document | Yes | User authenticated via Cognito |  |
| batchUpdateMetadata | Mutation | Update the metadata of a set of documents | Yes | User authenticated via Cognito | Used to upload the metadata as JSONL |
| listAvailableTools | Query | List the AI tools that can be attached to an agent | Yes | User authenticated via Cognito |  |
| listAvailableMcpServers | Query | List the MCP Servers that can be attached to an agent | Yes | User authenticated via Cognito |  |
| listRuntimeAgents | Query | List AgentCore runtimes | Yes | User authenticated via Cognito | This filters on AWS tags: stack name and environment |
| getRuntimeConfigurationByVersion | Query | Get the configuration (model, agent instructions, tools, and knowledge bases) associated with a specific runtime version | Yes | User authenticated via Cognito |  |
| getRuntimeConfigurationByQualifier | Query | Get the configuration (model, agent instructions, tools, and knowledge bases) associated with a specific endpoint label | Yes | User authenticated via Cognito | Qualifier = endpoint name |
| getDefaultRuntimeConfiguration | Query | Get the configuration (model, agent instructions, tools, and knowledge bases) associated with the DEFAULT endpoint | Yes | User authenticated via Cognito | Qualifier = DEFAULT that is the latest version |
| listAgentVersions | Query | List all the versions of an AgentCore runtime | Yes | User authenticated via Cognito |  |
| listAgentEndpoints | Query | List all the endpoints (qualifiers) of an AgentCore runtime | Yes | User authenticated via Cognito |  |
| getFavoriteRuntime | Query | Get the favorite AgentCore runtime and endpoint names | Yes | User authenticated via Cognito | The chatbot is initialized with the favorite runtime if any. |
| createAgentCoreRuntime | Mutation | Create an AgentCore runtime | Yes | User authenticated via Cognito |  |
| tagAgentCoreRuntime | Mutation | Tag an AgentCore runtime version with a label | Yes | User authenticated via Cognito | This creates de-facto an endpoint |
| deleteAgentRuntime | Mutation | Delete an AgentCore runtime | Yes | User authenticated via Cognito |  |
| deleteAgentRuntimeEndpoints | Mutation | Delete an AgentCore runtime endpoint | Yes | User authenticated via Cognito |  |
| updateFavoriteRuntime | Mutation | Update the favorite AgentCore runtime and endpoint | Yes | User authenticated via Cognito |  |
| resetFavoriteRuntime | Mutation | Remove the favorite endpoint for a given user | Yes | User authenticated via Cognito |  |
| publishRuntimeUpdate | Mutation | Notify on AgentCore Runtime Update | No | Lambda Function | Used for both delete runtime and delete endpoints |
| receiveUpdateNotification | Subscription |Receive AgentCore Runtime update | Yes | User authenticated via Cognito |  |
