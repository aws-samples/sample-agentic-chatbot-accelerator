/* tslint:disable */
/* eslint-disable */
// this is an auto generated file. This will be overwritten

import * as APITypes from "../API";
type GeneratedQuery<InputType, OutputType> = string & {
  __generatedQueryInput: InputType;
  __generatedQueryOutput: OutputType;
};

export const listSessions = /* GraphQL */ `query ListSessions {
  listSessions {
    id
    title
    startTime
    runtimeId
    runtimeVersion
    endpoint
    history {
      type
      content
      messageId
      references
      feedback
      reasoningContent
      toolActions
      executionTimeMs
      complete
      __typename
    }
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListSessionsQueryVariables,
  APITypes.ListSessionsQuery
>;
export const getSession = /* GraphQL */ `query GetSession($id: String!) {
  getSession(id: $id) {
    id
    title
    startTime
    runtimeId
    runtimeVersion
    endpoint
    history {
      type
      content
      messageId
      references
      feedback
      reasoningContent
      toolActions
      executionTimeMs
      complete
      __typename
    }
    __typename
  }
}
` as GeneratedQuery<
  APITypes.GetSessionQueryVariables,
  APITypes.GetSessionQuery
>;
export const getPresignedUrl = /* GraphQL */ `query GetPresignedUrl($s3Uri: String!, $pageNumber: Int) {
  getPresignedUrl(s3Uri: $s3Uri, pageNumber: $pageNumber)
}
` as GeneratedQuery<
  APITypes.GetPresignedUrlQueryVariables,
  APITypes.GetPresignedUrlQuery
>;
export const listKnowledgeBases = /* GraphQL */ `query ListKnowledgeBases {
  listKnowledgeBases {
    name
    id
    arn
    owner
    description
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListKnowledgeBasesQueryVariables,
  APITypes.ListKnowledgeBasesQuery
>;
export const listDataSources = /* GraphQL */ `query ListDataSources($kbId: String!) {
  listDataSources(kbId: $kbId) {
    name
    id
    prefixes
    description
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListDataSourcesQueryVariables,
  APITypes.ListDataSourcesQuery
>;
export const listDocuments = /* GraphQL */ `query ListDocuments($prefixes: [String!]!) {
  listDocuments(prefixes: $prefixes) {
    id
    name
    uri
    documentType
    inputPrefix
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListDocumentsQueryVariables,
  APITypes.ListDocumentsQuery
>;
export const getInputPrefix = /* GraphQL */ `query GetInputPrefix($kbId: String!, $dataSourceID: String!) {
  getInputPrefix(kbId: $kbId, dataSourceID: $dataSourceID)
}
` as GeneratedQuery<
  APITypes.GetInputPrefixQueryVariables,
  APITypes.GetInputPrefixQuery
>;
export const checkOnProcessStarted = /* GraphQL */ `query CheckOnProcessStarted($s3ObjectNames: [String!]!) {
  checkOnProcessStarted(s3ObjectNames: $s3ObjectNames)
}
` as GeneratedQuery<
  APITypes.CheckOnProcessStartedQueryVariables,
  APITypes.CheckOnProcessStartedQuery
>;
export const checkOnProcessCompleted = /* GraphQL */ `query CheckOnProcessCompleted($s3ObjectNames: [String!]!) {
  checkOnProcessCompleted(s3ObjectNames: $s3ObjectNames)
}
` as GeneratedQuery<
  APITypes.CheckOnProcessCompletedQueryVariables,
  APITypes.CheckOnProcessCompletedQuery
>;
export const checkOnDocumentsRemoved = /* GraphQL */ `query CheckOnDocumentsRemoved($s3ObjectNames: [String!]!) {
  checkOnDocumentsRemoved(s3ObjectNames: $s3ObjectNames)
}
` as GeneratedQuery<
  APITypes.CheckOnDocumentsRemovedQueryVariables,
  APITypes.CheckOnDocumentsRemovedQuery
>;
export const checkOnSyncInProgress = /* GraphQL */ `query CheckOnSyncInProgress($kbId: String!) {
  checkOnSyncInProgress(kbId: $kbId)
}
` as GeneratedQuery<
  APITypes.CheckOnSyncInProgressQueryVariables,
  APITypes.CheckOnSyncInProgressQuery
>;
export const getDocumentMetadata = /* GraphQL */ `query GetDocumentMetadata($documentId: String!) {
  getDocumentMetadata(documentId: $documentId)
}
` as GeneratedQuery<
  APITypes.GetDocumentMetadataQueryVariables,
  APITypes.GetDocumentMetadataQuery
>;
export const listAvailableTools = /* GraphQL */ `query ListAvailableTools {
  listAvailableTools {
    name
    description
    invokesSubAgent
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListAvailableToolsQueryVariables,
  APITypes.ListAvailableToolsQuery
>;
export const listAvailableMcpServers = /* GraphQL */ `query ListAvailableMcpServers {
  listAvailableMcpServers {
    name
    mcpUrl
    description
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListAvailableMcpServersQueryVariables,
  APITypes.ListAvailableMcpServersQuery
>;
export const listRuntimeAgents = /* GraphQL */ `query ListRuntimeAgents {
  listRuntimeAgents {
    agentName
    agentRuntimeId
    numberOfVersion
    qualifierToVersion
    status
    architectureType
    __typename
  }
}
` as GeneratedQuery<
  APITypes.ListRuntimeAgentsQueryVariables,
  APITypes.ListRuntimeAgentsQuery
>;
export const getRuntimeConfigurationByVersion = /* GraphQL */ `query GetRuntimeConfigurationByVersion(
  $agentName: String!
  $agentVersion: String!
) {
  getRuntimeConfigurationByVersion(
    agentName: $agentName
    agentVersion: $agentVersion
  )
}
` as GeneratedQuery<
  APITypes.GetRuntimeConfigurationByVersionQueryVariables,
  APITypes.GetRuntimeConfigurationByVersionQuery
>;
export const getRuntimeConfigurationByQualifier = /* GraphQL */ `query GetRuntimeConfigurationByQualifier(
  $agentName: String!
  $qualifier: String!
) {
  getRuntimeConfigurationByQualifier(
    agentName: $agentName
    qualifier: $qualifier
  )
}
` as GeneratedQuery<
  APITypes.GetRuntimeConfigurationByQualifierQueryVariables,
  APITypes.GetRuntimeConfigurationByQualifierQuery
>;
export const getDefaultRuntimeConfiguration = /* GraphQL */ `query GetDefaultRuntimeConfiguration($agentName: String!) {
  getDefaultRuntimeConfiguration(agentName: $agentName)
}
` as GeneratedQuery<
  APITypes.GetDefaultRuntimeConfigurationQueryVariables,
  APITypes.GetDefaultRuntimeConfigurationQuery
>;
export const listAgentVersions = /* GraphQL */ `query ListAgentVersions($agentRuntimeId: String!) {
  listAgentVersions(agentRuntimeId: $agentRuntimeId)
}
` as GeneratedQuery<
  APITypes.ListAgentVersionsQueryVariables,
  APITypes.ListAgentVersionsQuery
>;
export const listAgentEndpoints = /* GraphQL */ `query ListAgentEndpoints($agentRuntimeId: String!) {
  listAgentEndpoints(agentRuntimeId: $agentRuntimeId)
}
` as GeneratedQuery<
  APITypes.ListAgentEndpointsQueryVariables,
  APITypes.ListAgentEndpointsQuery
>;
export const getFavoriteRuntime = /* GraphQL */ `query GetFavoriteRuntime {
  getFavoriteRuntime {
    agentRuntimeId
    endpointName
    __typename
  }
}
` as GeneratedQuery<
  APITypes.GetFavoriteRuntimeQueryVariables,
  APITypes.GetFavoriteRuntimeQuery
>;
