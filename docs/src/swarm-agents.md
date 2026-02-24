# Swarm Agents

This guide explains how to create and test swarm agents using the Agentic Chatbot Accelerator. Swarm agents allow multiple specialised agents to collaborate via handoffs, where each agent focuses on a specific task and can delegate to others.

## Overview

A swarm agent consists of:

- **Agent References**: References to existing single agents that participate in the swarm
- **Entry Agent**: The agent that receives the initial user message
- **Orchestrator Settings**: Controls for execution limits (max handoffs, iterations, timeouts)
- **Conversation Manager**: How conversation history is managed across agents

Unlike single agents where one agent handles everything, swarm agents hand off conversations between specialised agents. For example, a software development swarm might have a researcher, a coder, a reviewer, and an architect — each handling their area of expertise and handing off when another specialist is needed.

## Prerequisites

Before creating a swarm agent, you need:

1. **At least two deployed single agents** with status "Ready" and a tagged endpoint (e.g. DEFAULT)
2. **The accelerator deployed** with the swarm feature enabled (CDK stack includes the swarm container image)

## Step-by-Step: Creating a Swarm Agent

### 1. Create the individual agents first

Each agent in the swarm is a regular single agent. Create them through the UI as you normally would:

1. Go to **Agent Factory** → **Create Agent**
2. Select **Single Agent** architecture
3. Configure each agent with its own instructions, model, and tools
4. Wait for each agent to reach "Ready" status

### 2. Create the swarm agent

1. Go to **Agent Factory** → **Create Agent**
2. In the **Architecture Type** step, select **Swarm**
3. Enter a name for the swarm agent (e.g. `softwaredevswarm`)

### 3. Configure agent references

In the **Swarm Configuration** step:

1. Use the **Select Agent** dropdown to add each agent you want in the swarm
2. For each agent, select the **Endpoint** from the dropdown (typically "DEFAULT")
3. You can remove agents using the ✕ button in the table

### 4. Set the entry agent

Select the **Entry Agent** — this is the agent that receives the user's first message. Typically this is a coordinator or researcher that triages the request.

### 5. Configure orchestrator settings

| Setting | Default | Description |
|---|---|---|
| Max Handoffs | 15 | Maximum times agents can hand off to each other |
| Max Iterations | 50 | Maximum total iterations across all agents |
| Execution Timeout (s) | 300 | Total swarm execution timeout |
| Node Timeout (s) | 60 | Timeout per individual agent |

These defaults work well for most use cases. Increase timeouts for complex multi-step workflows.

### 6. Review and create

Review the configuration summary and click **Create**. The swarm agent will go through the same creation pipeline as single agents (Step Function → AgentCore Runtime).

### 7. Test the swarm

Once the swarm agent reaches "Ready" status:

1. Go to the **Chat** interface
2. Select your swarm agent's endpoint
3. Send a message — it will be routed to the entry agent, which can then hand off to other agents as needed

## Example: Software Development Swarm

A team of specialised agents collaborating on a software task.

### Step 1 — Create four single agents

| Agent Name | Role | Instructions |
|---|---|---|
| `researcher` | Research specialist | "You are a research specialist. When given a task, research best practices, existing solutions, and relevant technologies. Hand off to the architect when you have enough context for system design." |
| `architect` | System architecture | "You are a system architecture specialist. Design system architectures, define API contracts, and plan component interactions. Hand off to the coder when the design is ready for implementation." |
| `coder` | Implementation | "You are a coding specialist. Implement solutions based on the architecture and research provided. Write clean, well-documented code. Hand off to the reviewer when implementation is complete." |
| `reviewer` | Code review | "You are a code review specialist. Review code for correctness, security, performance, and best practices. Provide the final summary to the user." |

Create each one through the UI:
1. **Agent Factory** → **Create Agent** → **Single Agent**
2. Set the agent name, instructions, and model (e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0`)
3. Wait for "Ready" status

### Step 2 — Create the swarm

1. **Agent Factory** → **Create Agent** → **Swarm**
2. Name: `softwaredevswarm`
3. Add agent references: `researcher` (DEFAULT), `architect` (DEFAULT), `coder` (DEFAULT), `reviewer` (DEFAULT)
4. Entry Agent: `researcher`
5. Orchestrator settings:
   - Max Handoffs: 20
   - Max Iterations: 50
   - Execution Timeout: 600s (10 min — software tasks can take longer)
   - Node Timeout: 120s

### Step 3 — Test it

Open the chat interface, select the `softwaredevswarm` endpoint, and try:

```
User: Design and implement a simple REST API for a todo app

→ researcher: I'll research best practices for REST API design for todo apps...
  [researches patterns, frameworks, data models]
  [handoff to architect]

→ architect: Based on the research, here's the system design...
  [defines endpoints, data schema, component structure]
  [handoff to coder]

→ coder: I'll implement the API based on the architecture...
  [writes the code with endpoints, models, error handling]
  [handoff to reviewer]

→ reviewer: Let me review the implementation...
  [reviews code quality, security, completeness]
  [provides final summary to user]
```

The agents collaborate autonomously — the researcher gathers context, the architect designs the solution, the coder implements it, and the reviewer validates the result.

## Viewing Swarm Configuration

To inspect an existing swarm agent's configuration:

1. Go to **Agent Factory**
2. Find the agent in the table — the **Architecture** column shows "SWARM"
3. Click on a version to open the **View Version** modal
4. The modal displays: entry agent, agent references with endpoints, orchestrator settings, and conversation manager

## How It Works Under the Hood

1. The UI sends a `createAgentCoreRuntime` mutation with `architectureType: SWARM` and the swarm config as `configValue`
2. The Agent Factory Resolver validates the config against `SwarmConfiguration` and starts a Step Function
3. The Step Function invokes the Create Runtime Version Lambda, which selects the swarm Docker container
4. At runtime, the swarm container's `data_source.py` loads each referenced agent's configuration from DynamoDB
5. The swarm orchestrator manages handoffs between agents based on the orchestrator settings

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Swarm creation fails | Referenced agent doesn't exist or has no endpoint | Ensure all referenced agents are in "Ready" status with a tagged endpoint |
| Agent not appearing in dropdown | Agent hasn't finished creating | Wait for the agent to reach "Ready" status |
| Handoffs not working | Entry agent instructions don't mention other agents | Update the entry agent's instructions to describe when to hand off and to which agents |
| Timeout errors | Complex workflows exceeding defaults | Increase execution timeout and node timeout in orchestrator settings |
| Repetitive handoffs | Agents passing control back and forth | Adjust agent instructions to be more specific about when to hand off vs when to respond directly |
