# Graph Agents

This guide explains how to create and test graph agents using the Agentic Chatbot Accelerator. Graph agents allow you to compose existing agents into stateful LangGraph workflows with directed edges and conditional routing.

## Overview

A graph agent consists of:

- **Graph Nodes**: References to existing single or swarm agents that participate in the workflow
- **Graph Edges**: Directed connections between nodes defining the execution flow (unconditional or conditional)
- **Entry Point**: The node that receives the initial user message
- **Orchestrator Settings**: Controls for execution limits (max iterations, timeouts)
- **State Schema**: Optional shared state fields that flow through the graph

Unlike swarm agents where agents hand off conversations dynamically, graph agents follow a predefined workflow. The execution path is determined by the graph structure and conditional edges. For example, a content pipeline might have a researcher → writer → reviewer flow, where the reviewer can loop back to the writer if revisions are needed.

## Prerequisites

Before creating a graph agent, you need:

1. **At least one deployed agent** (single or swarm) with status "Ready" and a tagged endpoint (e.g. DEFAULT)
2. **The accelerator deployed** with the graph feature enabled (CDK stack includes the graph container image)

## Step-by-Step: Creating a Graph Agent

### 1. Create the individual agents first

Each node in the graph references an existing agent. Create them through the UI as you normally would:

1. Go to **Agent Factory** → **Create Agent**
2. Select **Single Agent** (or **Swarm**) architecture
3. Configure each agent with its own instructions, model, and tools
4. Wait for each agent to reach "Ready" status

### 2. Create the graph agent

1. Go to **Agent Factory** → **Create Agent**
2. In the **Architecture Type** step, select **Graph**
3. Enter a name for the graph agent (e.g. `content_pipeline`)

### 3. Design the graph

In the **Graph Design** step:

#### Add nodes

1. Use the **Select an agent** dropdown to add agents as graph nodes
2. Each node gets a unique ID based on the agent name
3. You can add the same agent multiple times (each gets a distinct ID)
4. For each node, select the **Endpoint** from the dropdown (typically "DEFAULT")
5. Optionally set a **Label** for display purposes

#### Set the entry point

Click the **Set** button next to the node that should receive the initial user message. Exactly one entry point is required.

#### Add edges

1. Select a **Source Node** and **Target Node** from the dropdowns
2. For the final node in your workflow, set the target to **__end__**
3. Toggle **Conditional** to add a condition — enter a keyword that must appear in the source node's output for this edge to be followed
4. Click **Add Edge**

#### Define state schema (optional)

Add named fields and types for shared state that flows through the graph. If omitted, a default `messages` field is used.

![Graph Design — Step 1: Configuring nodes, entry point, edges, and state schema](../../imgs/agentic-patterns/agents-as-graph01.png)

### 4. Configure orchestrator settings

| Setting | Default | Description |
|---|---|---|
| Max Iterations | 50 | Maximum total iterations (LangGraph recursion limit) |
| Execution Timeout (s) | 300 | Total graph execution timeout |
| Node Timeout (s) | 60 | Timeout per individual node invocation |

These defaults work well for most use cases. Increase timeouts for workflows with many nodes or slow agents.

### 5. Review and create

The review step shows:

- A **visual minimap** of the graph topology (entry point, edges, conditions)
- A **JSON preview** of the complete graph configuration

Click **Create Runtime** to submit. The graph agent goes through the same creation pipeline as other agents (Step Function → AgentCore Runtime).

### 6. Test the graph

Once the graph agent reaches "Ready" status:

1. Go to the **Chat** interface
2. Select your graph agent's endpoint
3. Send a message — it enters at the entry point node and flows through the graph following the defined edges

## Example: Content Review Pipeline

A linear pipeline where content is researched, written, and reviewed.

### Step 1 — Create three single agents

| Agent Name | Role | Instructions |
|---|---|---|
| `researcher` | Research specialist | "You are a research specialist. When given a topic, gather relevant information, facts, and context. Provide a comprehensive research summary." |
| `writer` | Content writer | "You are a content writer. Using the research provided, write clear, engaging content. Structure your output with headings and paragraphs." |
| `reviewer` | Content reviewer | "You are a content reviewer. Review the content for accuracy, clarity, and completeness. Provide your final polished version." |

Create each one through the UI:
1. **Agent Factory** → **Create Agent** → **Single Agent**
2. Set the agent name, instructions, and model (e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0`)
3. Wait for "Ready" status

### Step 2 — Create the graph

1. **Agent Factory** → **Create Agent** → **Graph**
2. Name: `content_pipeline`
3. Add nodes: `researcher`, `writer`, `reviewer`
4. Entry Point: `researcher`
5. Add edges:
   - `researcher` → `writer` (unconditional)
   - `writer` → `reviewer` (unconditional)
   - `reviewer` → `__end__` (unconditional)
6. Orchestrator settings:
   - Max Iterations: 50
   - Execution Timeout: 600s (content generation can take longer)
   - Node Timeout: 120s

### Step 3 — Test it

Open the chat interface, select the `content_pipeline` endpoint, and try:

```
User: Write a blog post about the benefits of serverless architecture

→ researcher: [gathers information about serverless, key benefits, use cases]
→ writer: [writes a structured blog post based on the research]
→ reviewer: [reviews and polishes the final content]
→ Final response returned to user
```

The agents execute in sequence — the researcher gathers context, the writer creates the content, and the reviewer validates and polishes it.

## Example: Conditional Review Loop

A pipeline where the reviewer can send content back for revision.

### Graph structure

```
researcher → writer → reviewer --("approved")--> __end__
                ↑                --("revision")--> writer
```

### Setup

1. Create the same three agents as above
2. Create a graph agent with:
   - Nodes: `researcher`, `writer`, `reviewer`
   - Entry Point: `researcher`
   - Edges:
     - `researcher` → `writer` (unconditional)
     - `writer` → `reviewer` (unconditional)
     - `reviewer` → `__end__` (conditional: `approved`)
     - `reviewer` → `writer` (conditional: `revision`)

3. Update the reviewer's instructions to include routing keywords:
   > "Review the content. If it meets quality standards, include the word 'approved' in your response. If revisions are needed, include the word 'revision' and explain what needs to change."

The conditional routing checks if the reviewer's output contains the keyword. If "approved" appears, the graph ends. If "revision" appears, it loops back to the writer.

## Viewing Graph Configuration

To inspect an existing graph agent's configuration:

1. Go to **Agent Factory**
2. Find the agent in the table — the **Architecture** column shows "GRAPH"
3. Click on a version to open the **View Version** modal
4. The modal displays: entry point, nodes table (with agent names and endpoints), edges table (with conditions), and orchestrator settings

## Creating a New Version

To update a graph agent's configuration:

1. Select the graph agent in the **Agent Factory** table
2. Click **New version**
3. The wizard opens with the existing graph configuration pre-populated
4. Modify nodes, edges, or orchestrator settings as needed
5. Click **Create Runtime** to deploy the new version

## How It Works Under the Hood

1. The UI sends a `createAgentCoreRuntime` mutation with `architectureType: GRAPH` and the graph config as `configValue`
2. The Agent Factory Resolver validates the config against `GraphConfiguration` (Pydantic) and verifies all referenced agents exist
3. The Step Function invokes the Create Runtime Version Lambda, which selects the graph Docker container (`docker-graph/`)
4. At runtime, the graph container's `data_source.py` loads the graph configuration from DynamoDB
5. `factory.py` compiles the configuration into a LangGraph `StateGraph` — each node becomes a function that invokes the referenced agent via the AgentCore invoke API
6. When a message arrives, the compiled graph executes: the entry point node runs first, then edges determine the next node, until the graph reaches `__end__`
7. The final node's output is returned as the response

## Conditional Routing

Conditional edges use simple keyword matching against the previous node's output:

- The condition is a case-insensitive string (e.g. `"approved"`, `"revision"`, `"done"`)
- The router checks if the condition appears anywhere in the output text
- The first matching condition determines the next node
- If no condition matches, the first conditional edge's target is used as a fallback

**Tips for reliable routing:**
- Use distinctive keywords that won't appear accidentally (e.g. `"ROUTE_TO_WRITER"` instead of `"write"`)
- Include routing instructions in the agent's system prompt
- Test with various inputs to ensure conditions match as expected

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Graph creation fails | Referenced agent doesn't exist or has no endpoint | Ensure all referenced agents are in "Ready" status with a tagged endpoint |
| Agent not appearing in dropdown | Agent hasn't finished creating | Wait for the agent to reach "Ready" status |
| Empty or partial response | SSE response parsing issue | Check the graph container logs in CloudWatch (`/aws/bedrock-agentcore/runtimes/`) |
| Timeout errors | Complex workflows exceeding defaults | Increase execution timeout and node timeout in orchestrator settings |
| Wrong node executed | Conditional routing matched wrong keyword | Use more distinctive condition keywords and check agent instructions |
| Infinite loop | Unconditional cycle in the graph | Add a conditional edge with an exit condition to break the cycle |
| "Graph references non-existent agents" | Agent was deleted after graph was configured | Recreate the missing agent or update the graph to remove the reference |
