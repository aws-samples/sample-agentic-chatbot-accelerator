# GraphQL query reference — source of truth

> **Before adding or editing ANY query below, read the schema file
> [`src/api/schema/schema.graphql`](../../../../../../src/api/schema/schema.graphql)
> (relative to the repo root) and take field names, nullability, and selection-set
> shapes from there.** Do **not** rely on AppSync introspection (not explicitly
> enabled) and do **not** invent fields. The schema file is git-tracked and always
> present because this plugin ships inside the same repo.

All operations are `@aws_cognito_user_pools`. Authenticate with a Cognito **ID
token** (raw JWT, no `Bearer` prefix) via `scripts/gql.py`.

These are the exact documents the plugin scripts send. They are duplicated as
string constants where a script imports them; keep both in sync with the schema.

---

## Field-shape traps (verified against the schema)

1. **Config queries return a scalar `String!`** — `getDefaultRuntimeConfiguration`,
   `getRuntimeConfigurationByQualifier`, `getRuntimeConfigurationByVersion` take
   **no selection set**. The returned string is the JSON config (parse it yourself).
2. **`getSession` → `Session.history: [SessionHistoryItem]`** — the trace-relevant
   fields (`toolActions`, `reasoningContent`, `structuredOutput`, `executionTimeMs`,
   `feedback`, `references`, `complete`) live on `SessionHistoryItem` and must be
   **explicitly selected** or they come back null.
3. **`RuntimeSummary.agentRuntimeArnA2A` is nullable** and is the **A2A-twin
   signal** tasks 03/04 depend on — always select it. `numberOfVersion` and
   `qualifierToVersion` are `String!` (stringified). `status` is a free
   **`String!`**, not an enum — match it tolerantly (see task 05).
4. **`getEvaluator` → `Evaluator`** carries both `results: [EvaluationResult]`
   (tier-1 summaries) and `resultsS3Path` (tier-2 deep trajectory). Task 08's
   tiering maps onto these two fields.
5. **`createAgentCoreRuntime` returns a scalar `String!`** (`agentName`, or `""`
   on validation failure — no selection set, no GraphQL error). Local validation
   (task 03) runs first precisely because the empty-string failure is silent.

---

## Discovery / listing

### listRuntimeAgents
```graphql
query ListRuntimeAgents {
  listRuntimeAgents {
    agentName
    agentRuntimeId
    agentRuntimeArnA2A
    numberOfVersion
    qualifierToVersion
    status
    architectureType
  }
}
```

### listAvailableTools
```graphql
query ListAvailableTools {
  listAvailableTools {
    name
    description
    invokesSubAgent
  }
}
```

### listAvailableMcpServers
```graphql
query ListAvailableMcpServers {
  listAvailableMcpServers {
    name
    mcpUrl
    description
    authType
    source
  }
}
```

### listAvailableStateClasses  (graph workflows)
```graphql
query ListAvailableStateClasses {
  listAvailableStateClasses {
    key
    label
    description
    fields
  }
}
```

### listAvailableDeterministicNodes  (graph workflows)
```graphql
query ListAvailableDeterministicNodes {
  listAvailableDeterministicNodes {
    key
    label
    description
  }
}
```

### listSkills
```graphql
query ListSkills {
  listSkills {
    name
    description
    s3Key
    lastModified
  }
}
```

### listAgentVersions / listAgentEndpoints  (scalar string lists)
```graphql
query ListAgentVersions($agentRuntimeId: String!) {
  listAgentVersions(agentRuntimeId: $agentRuntimeId)
}
```
```graphql
query ListAgentEndpoints($agentRuntimeId: String!) {
  listAgentEndpoints(agentRuntimeId: $agentRuntimeId)
}
```

---

## Configuration fetch  (scalar `String!` — NO selection set)

```graphql
query GetDefaultRuntimeConfiguration($agentName: String!) {
  getDefaultRuntimeConfiguration(agentName: $agentName)
}
```
```graphql
query GetRuntimeConfigurationByQualifier($agentName: String!, $qualifier: String!) {
  getRuntimeConfigurationByQualifier(agentName: $agentName, qualifier: $qualifier)
}
```
```graphql
query GetRuntimeConfigurationByVersion($agentName: String!, $agentVersion: String!) {
  getRuntimeConfigurationByVersion(agentName: $agentName, agentVersion: $agentVersion)
}
```

---

## Session / trace fetch  (explicit SessionHistoryItem selection)

```graphql
query GetSession($id: String!) {
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
      structuredOutput
      toolActions
      executionTimeMs
      complete
    }
  }
}
```

---

## Evaluator fetch  (tier-1 results + tier-2 S3 path)

```graphql
query GetEvaluator($evaluatorId: ID!) {
  getEvaluator(evaluatorId: $evaluatorId) {
    evaluatorId
    name
    evaluatorType
    agentRuntimeName
    qualifier
    modelId
    passThreshold
    status
    passedCases
    failedCases
    totalTimeMs
    resultsS3Path
    results {
      caseName
      input
      expectedOutput
      actualOutput
      score
      passed
      reason
      latencyMs
    }
    errorMessage
    createdAt
    startedAt
    completedAt
  }
}
```

---

## Mutations

### createAgentCoreRuntime  (scalar `String!` — returns agentName or "")
```graphql
mutation CreateAgentCoreRuntime(
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
```
`architectureType` ∈ `SINGLE | SWARM | GRAPH | AGENTS_AS_TOOLS`.

### deleteAgentRuntime
```graphql
mutation DeleteAgentRuntime($agentName: String!, $agentRuntimeId: String!) {
  deleteAgentRuntime(agentName: $agentName, agentRuntimeId: $agentRuntimeId)
}
```

### tagAgentCoreRuntime  (version/qualifier tagging)
```graphql
mutation TagAgentCoreRuntime(
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
```
