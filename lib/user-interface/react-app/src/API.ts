/* tslint:disable */
/* eslint-disable */
//  This file was automatically generated and should not be edited.

export type Channel = {
  __typename: "Channel",
  data?: string | null,
  sessionId?: string | null,
  userId?: string | null,
};

export type DeleteSessionResult = {
  __typename: "DeleteSessionResult",
  id?: string | null,
  deleted: boolean,
};

export type DeleteDocumentResult = {
  __typename: "DeleteDocumentResult",
  id?: string | null,
  deleted: boolean,
};

export type AdminOpsResult = {
  __typename: "AdminOpsResult",
  id?: string | null,
  status: ResponseStatus,
};

export enum ResponseStatus {
  SUCCESSFUL = "SUCCESSFUL",
  INVALID_CONFIG = "INVALID_CONFIG",
  INVALID_NAME = "INVALID_NAME",
  SERVICE_ERROR = "SERVICE_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
  ALREADY_EXISTS = "ALREADY_EXISTS",
}


export type AgentFactoryNotification = {
  __typename: "AgentFactoryNotification",
  agentName?: string | null,
};

export type Session = {
  __typename: "Session",
  id: string,
  title?: string | null,
  startTime: string,
  runtimeId: string,
  runtimeVersion: string,
  endpoint: string,
  history?:  Array<SessionHistoryItem | null > | null,
};

export type SessionHistoryItem = {
  __typename: "SessionHistoryItem",
  type: string,
  content: string,
  messageId: string,
  references?: string | null,
  feedback?: string | null,
  reasoningContent?: string | null,
  toolActions?: string | null,
  executionTimeMs?: number | null,
  complete?: boolean | null,
};

export type KnowledgeBase = {
  __typename: "KnowledgeBase",
  name: string,
  id: string,
  arn: string,
  owner: string,
  description?: string | null,
};

export type S3DataSource = {
  __typename: "S3DataSource",
  name: string,
  id: string,
  prefixes: Array< string >,
  description?: string | null,
};

export type S3Document = {
  __typename: "S3Document",
  id: string,
  name: string,
  uri: string,
  documentType: string,
  inputPrefix: string,
};

export type Tool = {
  __typename: "Tool",
  name: string,
  description: string,
  invokesSubAgent: boolean,
};

export type McpServer = {
  __typename: "McpServer",
  name: string,
  mcpUrl: string,
  description: string,
};

export type RuntimeSummary = {
  __typename: "RuntimeSummary",
  agentName: string,
  agentRuntimeId: string,
  numberOfVersion: string,
  qualifierToVersion: string,
  status: string,
};

export type FavoriteRuntime = {
  __typename: "FavoriteRuntime",
  agentRuntimeId: string,
  endpointName: string,
};

export type SendQueryMutationVariables = {
  data?: string | null,
};

export type SendQueryMutation = {
  sendQuery?: string | null,
};

export type PublishResponseMutationVariables = {
  sessionId?: string | null,
  userId?: string | null,
  data?: string | null,
};

export type PublishResponseMutation = {
  publishResponse?:  {
    __typename: "Channel",
    data?: string | null,
    sessionId?: string | null,
    userId?: string | null,
  } | null,
};

export type DeleteUserSessionsMutationVariables = {
};

export type DeleteUserSessionsMutation = {
  deleteUserSessions?:  Array< {
    __typename: "DeleteSessionResult",
    id?: string | null,
    deleted: boolean,
  } > | null,
};

export type DeleteSessionMutationVariables = {
  id: string,
};

export type DeleteSessionMutation = {
  deleteSession?:  {
    __typename: "DeleteSessionResult",
    id?: string | null,
    deleted: boolean,
  } | null,
};

export type RenameSessionMutationVariables = {
  id: string,
  title: string,
};

export type RenameSessionMutation = {
  renameSession?: boolean | null,
};

export type UpdateMessageExecutionTimeMutationVariables = {
  sessionId: string,
  messageId: string,
  executionTimeMs: number,
};

export type UpdateMessageExecutionTimeMutation = {
  updateMessageExecutionTime?: boolean | null,
};

export type SaveToolActionsMutationVariables = {
  sessionId: string,
  messageId: string,
  toolActions: string,
};

export type SaveToolActionsMutation = {
  saveToolActions?: boolean | null,
};

export type PublishFeedbackMutationVariables = {
  feedback: string,
  messageId: string,
  messageType: string,
  sessionId: string,
};

export type PublishFeedbackMutation = {
  publishFeedback?: boolean | null,
};

export type DeleteDocumentMutationVariables = {
  uri: string,
};

export type DeleteDocumentMutation = {
  deleteDocument?:  {
    __typename: "DeleteDocumentResult",
    id?: string | null,
    deleted: boolean,
  } | null,
};

export type CreateKnowledgeBaseMutationVariables = {
  kbName: string,
  props: string,
};

export type CreateKnowledgeBaseMutation = {
  createKnowledgeBase?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type DeleteKnowledgeBaseMutationVariables = {
  kbId: string,
};

export type DeleteKnowledgeBaseMutation = {
  deleteKnowledgeBase?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type CreateDataSourceMutationVariables = {
  kbId: string,
  dsName: string,
  props: string,
};

export type CreateDataSourceMutation = {
  createDataSource?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type DeleteDataSourceMutationVariables = {
  kbId: string,
  dataSourceId: string,
};

export type DeleteDataSourceMutation = {
  deleteDataSource?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type SyncKnowledgeBaseMutationVariables = {
  kbId: string,
};

export type SyncKnowledgeBaseMutation = {
  syncKnowledgeBase?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type UpdateMetadataMutationVariables = {
  documentId: string,
  metadata: string,
};

export type UpdateMetadataMutation = {
  updateMetadata?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type BatchUpdateMetadataMutationVariables = {
  metadataFile: string,
};

export type BatchUpdateMetadataMutation = {
  batchUpdateMetadata?:  {
    __typename: "AdminOpsResult",
    id?: string | null,
    status: ResponseStatus,
  } | null,
};

export type CreateAgentCoreRuntimeMutationVariables = {
  agentName: string,
  configValue: string,
};

export type CreateAgentCoreRuntimeMutation = {
  createAgentCoreRuntime: string,
};

export type TagAgentCoreRuntimeMutationVariables = {
  agentName: string,
  agentRuntimeId: string,
  currentQualifierToVersion: string,
  agentVersion: string,
  qualifier: string,
  description?: string | null,
};

export type TagAgentCoreRuntimeMutation = {
  tagAgentCoreRuntime?: string | null,
};

export type DeleteAgentRuntimeMutationVariables = {
  agentName: string,
  agentRuntimeId: string,
};

export type DeleteAgentRuntimeMutation = {
  deleteAgentRuntime: string,
};

export type DeleteAgentRuntimeEndpointsMutationVariables = {
  agentName: string,
  agentRuntimeId: string,
  endpointNames?: Array< string > | null,
};

export type DeleteAgentRuntimeEndpointsMutation = {
  deleteAgentRuntimeEndpoints: string,
};

export type UpdateFavoriteRuntimeMutationVariables = {
  agentRuntimeId: string,
  endpointName: string,
};

export type UpdateFavoriteRuntimeMutation = {
  updateFavoriteRuntime?: string | null,
};

export type ResetFavoriteRuntimeMutationVariables = {
};

export type ResetFavoriteRuntimeMutation = {
  resetFavoriteRuntime?: string | null,
};

export type PublishRuntimeUpdateMutationVariables = {
  agentName: string,
};

export type PublishRuntimeUpdateMutation = {
  publishRuntimeUpdate?:  {
    __typename: "AgentFactoryNotification",
    agentName?: string | null,
  } | null,
};

export type ListSessionsQueryVariables = {
};

export type ListSessionsQuery = {
  listSessions:  Array< {
    __typename: "Session",
    id: string,
    title?: string | null,
    startTime: string,
    runtimeId: string,
    runtimeVersion: string,
    endpoint: string,
    history?:  Array< {
      __typename: "SessionHistoryItem",
      type: string,
      content: string,
      messageId: string,
      references?: string | null,
      feedback?: string | null,
      reasoningContent?: string | null,
      toolActions?: string | null,
      executionTimeMs?: number | null,
      complete?: boolean | null,
    } | null > | null,
  } >,
};

export type GetSessionQueryVariables = {
  id: string,
};

export type GetSessionQuery = {
  getSession?:  {
    __typename: "Session",
    id: string,
    title?: string | null,
    startTime: string,
    runtimeId: string,
    runtimeVersion: string,
    endpoint: string,
    history?:  Array< {
      __typename: "SessionHistoryItem",
      type: string,
      content: string,
      messageId: string,
      references?: string | null,
      feedback?: string | null,
      reasoningContent?: string | null,
      toolActions?: string | null,
      executionTimeMs?: number | null,
      complete?: boolean | null,
    } | null > | null,
  } | null,
};

export type GetPresignedUrlQueryVariables = {
  s3Uri: string,
  pageNumber?: number | null,
};

export type GetPresignedUrlQuery = {
  getPresignedUrl?: string | null,
};

export type ListKnowledgeBasesQueryVariables = {
};

export type ListKnowledgeBasesQuery = {
  listKnowledgeBases:  Array< {
    __typename: "KnowledgeBase",
    name: string,
    id: string,
    arn: string,
    owner: string,
    description?: string | null,
  } >,
};

export type ListDataSourcesQueryVariables = {
  kbId: string,
};

export type ListDataSourcesQuery = {
  listDataSources:  Array< {
    __typename: "S3DataSource",
    name: string,
    id: string,
    prefixes: Array< string >,
    description?: string | null,
  } >,
};

export type ListDocumentsQueryVariables = {
  prefixes: Array< string >,
};

export type ListDocumentsQuery = {
  listDocuments:  Array< {
    __typename: "S3Document",
    id: string,
    name: string,
    uri: string,
    documentType: string,
    inputPrefix: string,
  } >,
};

export type GetInputPrefixQueryVariables = {
  kbId: string,
  dataSourceID: string,
};

export type GetInputPrefixQuery = {
  getInputPrefix?: string | null,
};

export type CheckOnProcessStartedQueryVariables = {
  s3ObjectNames: Array< string >,
};

export type CheckOnProcessStartedQuery = {
  checkOnProcessStarted?: boolean | null,
};

export type CheckOnProcessCompletedQueryVariables = {
  s3ObjectNames: Array< string >,
};

export type CheckOnProcessCompletedQuery = {
  checkOnProcessCompleted?: boolean | null,
};

export type CheckOnDocumentsRemovedQueryVariables = {
  s3ObjectNames: Array< string >,
};

export type CheckOnDocumentsRemovedQuery = {
  checkOnDocumentsRemoved?: boolean | null,
};

export type CheckOnSyncInProgressQueryVariables = {
  kbId: string,
};

export type CheckOnSyncInProgressQuery = {
  checkOnSyncInProgress?: boolean | null,
};

export type GetDocumentMetadataQueryVariables = {
  documentId: string,
};

export type GetDocumentMetadataQuery = {
  getDocumentMetadata: string,
};

export type ListAvailableToolsQueryVariables = {
};

export type ListAvailableToolsQuery = {
  listAvailableTools?:  Array< {
    __typename: "Tool",
    name: string,
    description: string,
    invokesSubAgent: boolean,
  } > | null,
};

export type ListAvailableMcpServersQueryVariables = {
};

export type ListAvailableMcpServersQuery = {
  listAvailableMcpServers?:  Array< {
    __typename: "McpServer",
    name: string,
    mcpUrl: string,
    description: string,
  } > | null,
};

export type ListRuntimeAgentsQueryVariables = {
};

export type ListRuntimeAgentsQuery = {
  listRuntimeAgents?:  Array< {
    __typename: "RuntimeSummary",
    agentName: string,
    agentRuntimeId: string,
    numberOfVersion: string,
    qualifierToVersion: string,
    status: string,
  } > | null,
};

export type GetRuntimeConfigurationByVersionQueryVariables = {
  agentName: string,
  agentVersion: string,
};

export type GetRuntimeConfigurationByVersionQuery = {
  getRuntimeConfigurationByVersion: string,
};

export type GetRuntimeConfigurationByQualifierQueryVariables = {
  agentName: string,
  qualifier: string,
};

export type GetRuntimeConfigurationByQualifierQuery = {
  getRuntimeConfigurationByQualifier: string,
};

export type GetDefaultRuntimeConfigurationQueryVariables = {
  agentName: string,
};

export type GetDefaultRuntimeConfigurationQuery = {
  getDefaultRuntimeConfiguration: string,
};

export type ListAgentVersionsQueryVariables = {
  agentRuntimeId: string,
};

export type ListAgentVersionsQuery = {
  listAgentVersions?: Array< string | null > | null,
};

export type ListAgentEndpointsQueryVariables = {
  agentRuntimeId: string,
};

export type ListAgentEndpointsQuery = {
  listAgentEndpoints?: Array< string | null > | null,
};

export type GetFavoriteRuntimeQueryVariables = {
};

export type GetFavoriteRuntimeQuery = {
  getFavoriteRuntime?:  {
    __typename: "FavoriteRuntime",
    agentRuntimeId: string,
    endpointName: string,
  } | null,
};

export type ReceiveMessagesSubscriptionVariables = {
  sessionId?: string | null,
};

export type ReceiveMessagesSubscription = {
  receiveMessages?:  {
    __typename: "Channel",
    data?: string | null,
    sessionId?: string | null,
    userId?: string | null,
  } | null,
};

export type ReceiveUpdateNotificationSubscriptionVariables = {
  agentName: string,
};

export type ReceiveUpdateNotificationSubscription = {
  receiveUpdateNotification?:  {
    __typename: "AgentFactoryNotification",
    agentName?: string | null,
  } | null,
};
