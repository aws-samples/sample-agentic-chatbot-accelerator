/* tslint:disable */
/* eslint-disable */
// this is an auto generated file. This will be overwritten

import * as APITypes from "../API";
type GeneratedMutation<InputType, OutputType> = string & {
  __generatedMutationInput: InputType;
  __generatedMutationOutput: OutputType;
};

export const sendQuery = /* GraphQL */ `mutation SendQuery($data: String) {
  sendQuery(data: $data)
}
` as GeneratedMutation<
  APITypes.SendQueryMutationVariables,
  APITypes.SendQueryMutation
>;
export const publishResponse = /* GraphQL */ `mutation PublishResponse($sessionId: String, $userId: String, $data: String) {
  publishResponse(sessionId: $sessionId, userId: $userId, data: $data) {
    data
    sessionId
    userId
    __typename
  }
}
` as GeneratedMutation<
  APITypes.PublishResponseMutationVariables,
  APITypes.PublishResponseMutation
>;
export const deleteUserSessions = /* GraphQL */ `mutation DeleteUserSessions {
  deleteUserSessions {
    id
    deleted
    __typename
  }
}
` as GeneratedMutation<
  APITypes.DeleteUserSessionsMutationVariables,
  APITypes.DeleteUserSessionsMutation
>;
export const deleteSession = /* GraphQL */ `mutation DeleteSession($id: String!) {
  deleteSession(id: $id) {
    id
    deleted
    __typename
  }
}
` as GeneratedMutation<
  APITypes.DeleteSessionMutationVariables,
  APITypes.DeleteSessionMutation
>;
export const renameSession = /* GraphQL */ `mutation RenameSession($id: String!, $title: String!) {
  renameSession(id: $id, title: $title)
}
` as GeneratedMutation<
  APITypes.RenameSessionMutationVariables,
  APITypes.RenameSessionMutation
>;
export const updateMessageExecutionTime = /* GraphQL */ `mutation UpdateMessageExecutionTime(
  $sessionId: String!
  $messageId: String!
  $executionTimeMs: Int!
) {
  updateMessageExecutionTime(
    sessionId: $sessionId
    messageId: $messageId
    executionTimeMs: $executionTimeMs
  )
}
` as GeneratedMutation<
  APITypes.UpdateMessageExecutionTimeMutationVariables,
  APITypes.UpdateMessageExecutionTimeMutation
>;
export const saveToolActions = /* GraphQL */ `mutation SaveToolActions(
  $sessionId: String!
  $messageId: String!
  $toolActions: String!
) {
  saveToolActions(
    sessionId: $sessionId
    messageId: $messageId
    toolActions: $toolActions
  )
}
` as GeneratedMutation<
  APITypes.SaveToolActionsMutationVariables,
  APITypes.SaveToolActionsMutation
>;
export const publishFeedback = /* GraphQL */ `mutation PublishFeedback(
  $feedback: String!
  $messageId: String!
  $messageType: String!
  $sessionId: String!
) {
  publishFeedback(
    feedback: $feedback
    messageId: $messageId
    messageType: $messageType
    sessionId: $sessionId
  )
}
` as GeneratedMutation<
  APITypes.PublishFeedbackMutationVariables,
  APITypes.PublishFeedbackMutation
>;
export const deleteDocument = /* GraphQL */ `mutation DeleteDocument($uri: String!) {
  deleteDocument(uri: $uri) {
    id
    deleted
    __typename
  }
}
` as GeneratedMutation<
  APITypes.DeleteDocumentMutationVariables,
  APITypes.DeleteDocumentMutation
>;
export const createKnowledgeBase = /* GraphQL */ `mutation CreateKnowledgeBase($kbName: String!, $props: String!) {
  createKnowledgeBase(kbName: $kbName, props: $props) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.CreateKnowledgeBaseMutationVariables,
  APITypes.CreateKnowledgeBaseMutation
>;
export const deleteKnowledgeBase = /* GraphQL */ `mutation DeleteKnowledgeBase($kbId: String!) {
  deleteKnowledgeBase(kbId: $kbId) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.DeleteKnowledgeBaseMutationVariables,
  APITypes.DeleteKnowledgeBaseMutation
>;
export const createDataSource = /* GraphQL */ `mutation CreateDataSource($kbId: String!, $dsName: String!, $props: String!) {
  createDataSource(kbId: $kbId, dsName: $dsName, props: $props) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.CreateDataSourceMutationVariables,
  APITypes.CreateDataSourceMutation
>;
export const deleteDataSource = /* GraphQL */ `mutation DeleteDataSource($kbId: String!, $dataSourceId: String!) {
  deleteDataSource(kbId: $kbId, dataSourceId: $dataSourceId) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.DeleteDataSourceMutationVariables,
  APITypes.DeleteDataSourceMutation
>;
export const syncKnowledgeBase = /* GraphQL */ `mutation SyncKnowledgeBase($kbId: String!) {
  syncKnowledgeBase(kbId: $kbId) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.SyncKnowledgeBaseMutationVariables,
  APITypes.SyncKnowledgeBaseMutation
>;
export const updateMetadata = /* GraphQL */ `mutation UpdateMetadata($documentId: String!, $metadata: String!) {
  updateMetadata(documentId: $documentId, metadata: $metadata) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.UpdateMetadataMutationVariables,
  APITypes.UpdateMetadataMutation
>;
export const batchUpdateMetadata = /* GraphQL */ `mutation BatchUpdateMetadata($metadataFile: String!) {
  batchUpdateMetadata(metadataFile: $metadataFile) {
    id
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.BatchUpdateMetadataMutationVariables,
  APITypes.BatchUpdateMetadataMutation
>;
export const createAgentCoreRuntime = /* GraphQL */ `mutation CreateAgentCoreRuntime(
  $agentName: String!
  $configValue: String!
  $architectureType: ArchitectureType
) {
  createAgentCoreRuntime(
    agentName: $agentName
    configValue: $configValue
    architectureType: $architectureType
  )
}
` as GeneratedMutation<
  APITypes.CreateAgentCoreRuntimeMutationVariables,
  APITypes.CreateAgentCoreRuntimeMutation
>;
export const tagAgentCoreRuntime = /* GraphQL */ `mutation TagAgentCoreRuntime(
  $agentName: String!
  $agentRuntimeId: String!
  $currentQualifierToVersion: String!
  $agentVersion: String!
  $qualifier: String!
  $description: String
) {
  tagAgentCoreRuntime(
    agentName: $agentName
    agentRuntimeId: $agentRuntimeId
    currentQualifierToVersion: $currentQualifierToVersion
    agentVersion: $agentVersion
    qualifier: $qualifier
    description: $description
  )
}
` as GeneratedMutation<
  APITypes.TagAgentCoreRuntimeMutationVariables,
  APITypes.TagAgentCoreRuntimeMutation
>;
export const deleteAgentRuntime = /* GraphQL */ `mutation DeleteAgentRuntime($agentName: String!, $agentRuntimeId: String!) {
  deleteAgentRuntime(agentName: $agentName, agentRuntimeId: $agentRuntimeId)
}
` as GeneratedMutation<
  APITypes.DeleteAgentRuntimeMutationVariables,
  APITypes.DeleteAgentRuntimeMutation
>;
export const deleteAgentRuntimeEndpoints = /* GraphQL */ `mutation DeleteAgentRuntimeEndpoints(
  $agentName: String!
  $agentRuntimeId: String!
  $endpointNames: [String!]
) {
  deleteAgentRuntimeEndpoints(
    agentName: $agentName
    agentRuntimeId: $agentRuntimeId
    endpointNames: $endpointNames
  )
}
` as GeneratedMutation<
  APITypes.DeleteAgentRuntimeEndpointsMutationVariables,
  APITypes.DeleteAgentRuntimeEndpointsMutation
>;
export const updateFavoriteRuntime = /* GraphQL */ `mutation UpdateFavoriteRuntime(
  $agentRuntimeId: String!
  $endpointName: String!
) {
  updateFavoriteRuntime(
    agentRuntimeId: $agentRuntimeId
    endpointName: $endpointName
  )
}
` as GeneratedMutation<
  APITypes.UpdateFavoriteRuntimeMutationVariables,
  APITypes.UpdateFavoriteRuntimeMutation
>;
export const resetFavoriteRuntime = /* GraphQL */ `mutation ResetFavoriteRuntime {
  resetFavoriteRuntime
}
` as GeneratedMutation<
  APITypes.ResetFavoriteRuntimeMutationVariables,
  APITypes.ResetFavoriteRuntimeMutation
>;
export const publishRuntimeUpdate = /* GraphQL */ `mutation PublishRuntimeUpdate($agentName: String!) {
  publishRuntimeUpdate(agentName: $agentName) {
    agentName
    __typename
  }
}
` as GeneratedMutation<
  APITypes.PublishRuntimeUpdateMutationVariables,
  APITypes.PublishRuntimeUpdateMutation
>;
export const createEvaluator = /* GraphQL */ `mutation CreateEvaluator($input: CreateEvaluatorInput!) {
  createEvaluator(input: $input) {
    evaluatorId
    name
    description
    evaluatorType
    customRubric
    agentRuntimeName
    qualifier
    modelId
    passThreshold
    testCasesS3Path
    testCasesCount
    resultsS3Path
    status
    passedCases
    failedCases
    totalTimeMs
    results {
      caseName
      input
      expectedOutput
      actualOutput
      score
      passed
      reason
      latencyMs
      __typename
    }
    errorMessage
    createdAt
    startedAt
    completedAt
    __typename
  }
}
` as GeneratedMutation<
  APITypes.CreateEvaluatorMutationVariables,
  APITypes.CreateEvaluatorMutation
>;
export const deleteEvaluator = /* GraphQL */ `mutation DeleteEvaluator($evaluatorId: ID!) {
  deleteEvaluator(evaluatorId: $evaluatorId)
}
` as GeneratedMutation<
  APITypes.DeleteEvaluatorMutationVariables,
  APITypes.DeleteEvaluatorMutation
>;
export const runEvaluation = /* GraphQL */ `mutation RunEvaluation($evaluatorId: ID!) {
  runEvaluation(evaluatorId: $evaluatorId) {
    evaluatorId
    name
    description
    evaluatorType
    customRubric
    agentRuntimeName
    qualifier
    modelId
    passThreshold
    testCasesS3Path
    testCasesCount
    resultsS3Path
    status
    passedCases
    failedCases
    totalTimeMs
    results {
      caseName
      input
      expectedOutput
      actualOutput
      score
      passed
      reason
      latencyMs
      __typename
    }
    errorMessage
    createdAt
    startedAt
    completedAt
    __typename
  }
}
` as GeneratedMutation<
  APITypes.RunEvaluationMutationVariables,
  APITypes.RunEvaluationMutation
>;
export const publishEvaluationUpdate = /* GraphQL */ `mutation PublishEvaluationUpdate($evaluatorId: String!, $status: String!) {
  publishEvaluationUpdate(evaluatorId: $evaluatorId, status: $status) {
    evaluatorId
    status
    __typename
  }
}
` as GeneratedMutation<
  APITypes.PublishEvaluationUpdateMutationVariables,
  APITypes.PublishEvaluationUpdateMutation
>;
