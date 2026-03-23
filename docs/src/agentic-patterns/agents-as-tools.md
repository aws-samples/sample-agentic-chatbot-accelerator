# Agents as Tools

This guide explains how to create and test agents using the **agents-as-tools** pattern with the Agentic Chatbot Accelerator. In this pattern, an orchestrator agent delegates tasks to specialized sub-agents that are exposed as callable tools.

## Overview

An agents-as-tools configuration consists of:

- **Orchestrator Agent**: A central agent with its own model, instructions, and reasoning capabilities that decides which sub-agents to invoke
- **Sub-Agents as Tools**: Existing deployed agents that are exposed as tools to the orchestrator, each with a defined **role** describing its specialization
- **Endpoint**: The qualifier/endpoint of each sub-agent (e.g. `DEFAULT`)
- **Optional Tools**: Additional tools, knowledge bases, and MCP servers available to the orchestrator alongside the sub-agent tools

Unlike graph agents where the execution flow is predefined by edges, the orchestrator dynamically decides which sub-agent(s) to invoke based on the user's request and each sub-agent's role description. The orchestrator can invoke multiple sub-agents in sequence, combine their outputs, and reason about the results before responding to the user.

This pattern is inspired by the [Strands Agents multi-agent agents-as-tools](https://strandsagents.com/docs/user-guide/concepts/multi-agent/agents-as-tools/) approach: each sub-agent is wrapped as a tool with a description derived from its role, allowing the orchestrator to select the right agent for each task.

## Prerequisites

Before creating an agents-as-tools orchestrator, you need:

1. **At least one deployed agent** (single, swarm, or graph) with status "Ready" and a tagged endpoint (e.g. DEFAULT)
2. **The accelerator deployed** with the agents-as-tools feature enabled (CDK stack includes the agents-as-tools container image)

## Step-by-Step: Creating an Agents-as-Tools Orchestrator

### 1. Create the sub-agents first

Each sub-agent is an independent agent that can be invoked on its own. Create them through the UI:

1. Go to **Agent Factory** → **Create Agent**
2. Select **Single Agent** architecture
3. Configure the agent with its own name, instructions, and model
4. Wait for it to reach "Ready" status and ensure it has a tagged endpoint (e.g. DEFAULT)

### 2. Create the orchestrator agent

1. Go to **Agent Factory** → **Create Agent**
2. In the **Architecture Type** step, select **Agents as Tools**
3. Enter a name for the orchestrator agent (e.g. `travel_planner`)

### 3. Add sub-agents as tools

In the **Agents as Tools** step:

1. Use the **Select an agent** dropdown to add existing agents as tools
2. For each agent, select the **Endpoint** from the dropdown (typically "DEFAULT")
3. Enter a **Role** description — this is critical as the orchestrator uses it to decide when to invoke each sub-agent. Be specific and descriptive about what the agent can do.
4. You can add multiple sub-agents; the orchestrator will reason about which one(s) to call

![Agents as Tools — Step 1: Adding sub-agents with endpoint and role configuration](../../imgs/agentic-patterns/agents-as-tools-01.png)

### 4. Configure the orchestrator

In the **Orchestrator Configuration** step:

1. **Model**: Select the LLM model for the orchestrator (e.g. Claude Haiku 4.5)
2. **Instructions**: Write a system prompt that tells the orchestrator how to use its sub-agents. Reference the sub-agents by their roles and explain the delegation strategy.
3. **Conversation Manager**: Choose how conversation history is managed (Sliding Window is recommended)
4. **Additional Tools** (optional): Add extra tools, knowledge bases, or MCP servers that the orchestrator can use directly alongside its sub-agent tools

![Orchestrator Configuration — Step 2: Model, instructions, conversation manager, and additional tools](../../imgs/agentic-patterns/agents-as-tools-02.png)

### 5. Review and create

The review step shows:

- A **Sub-Agent Tools** summary table (agent name, endpoint, role)
- A **JSON preview** of the complete configuration

Click **Create Runtime** to submit. The orchestrator agent goes through the same creation pipeline as other agents (Step Function → AgentCore Runtime).

### 6. Test the orchestrator

Once the orchestrator reaches "Ready" status:

1. Go to the **Chat** interface
2. Select your orchestrator agent's endpoint
3. Send a message — the orchestrator will analyze the request, decide which sub-agent(s) to invoke, and synthesize a response

## Example: Travel Planning Agent

A travel planning orchestrator that delegates to specialized sub-agents for booking and activities.

### Step 1 — Create two sub-agents

| Agent Name | Instructions |
|---|---|
| `booking_agent` | "You are a booking assistant specializing in travel reservations. When given a travel request, simulate looking up available flights and hotels for the requested destination and dates. Provide realistic-looking options with prices, airlines, hotel names, and ratings. Format your response clearly with separate sections for flights and accommodations. Since you don't have access to real booking systems, generate plausible options based on the destination." |
| `activities_agent` | "You are a local activities and excursions expert. When given a travel destination and dates, simulate researching and recommending local activities, tours, restaurants, and cultural experiences. Provide realistic suggestions with estimated costs, durations, and brief descriptions. Organize recommendations by category (sightseeing, food, adventure, culture). Since you don't have access to real activity databases, generate plausible recommendations based on the destination." |

Create each one through the UI:

1. **Agent Factory** → **Create Agent** → **Single Agent**
2. Set the agent name, instructions, and model (e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0`)
3. Do **not** add any tools — the agents will simulate their responses
4. Wait for "Ready" status

### Step 2 — Create the orchestrator

1. **Agent Factory** → **Create Agent** → **Agents as Tools**
2. Name: `travel_planner`

#### Add sub-agents

| Agent | Endpoint | Role |
|---|---|---|
| `booking_agent` | DEFAULT | "Handles travel booking research including flights and hotel availability. Invoke this agent when the user needs help finding or comparing travel options like flights, hotels, or rental cars for specific destinations and dates." |
| `activities_agent` | DEFAULT | "Researches and recommends local activities, tours, and dining options at travel destinations. Invoke this agent when the user wants suggestions for things to do, places to eat, or experiences to have at their destination." |

#### Orchestrator instructions

```
You are a helpful travel planning assistant that coordinates specialized agents to help users plan their trips.

You have access to the following specialized agents:
- A booking agent that can research flights and hotels
- An activities agent that can recommend local activities and dining

When a user asks about planning a trip:
1. First, use the booking agent to find flight and hotel options for their destination and dates
2. Then, use the activities agent to recommend things to do at the destination
3. Combine the results into a comprehensive travel plan with a clear itinerary

Always pass complete context to each agent — include the destination, dates, preferences, budget, and any other relevant details from the user's request. The sub-agents cannot see the conversation history, so you must include all necessary information in each request.

If the user only asks about one aspect (e.g., just flights or just activities), only invoke the relevant agent.
```

#### Model and settings

- Model: Claude Haiku 4.5 (or your preferred model)
- Temperature: 0.2
- Max Tokens: 3000
- Conversation Manager: Sliding Window

### Step 3 — Test it

Open the chat interface, select the `travel_planner` endpoint, and try:

```
User: I'm planning a 5-day trip to Tokyo in April. My budget is around $3000.
      Can you help me find flights from New York, a good hotel, and suggest activities?

→ Orchestrator analyzes the request
→ Invokes booking_agent: "Find flights from New York to Tokyo in April and
   hotels for 5 nights. Budget around $3000 total."
→ Invokes activities_agent: "Recommend activities, restaurants, and cultural
   experiences for a 5-day trip to Tokyo in April."
→ Orchestrator combines both responses into a comprehensive travel plan
→ Final response returned to user with flights, hotel, and activity recommendations
```

The orchestrator dynamically decides which sub-agents to invoke based on the user's request. If the user later asks "What else can I do in Shibuya?", the orchestrator will only invoke the activities agent since no booking information is needed.

## Viewing Agents-as-Tools Configuration

To inspect an existing agents-as-tools configuration:

1. Go to **Agent Factory**
2. Find the agent in the table — the **Architecture** column shows "AGENTS_AS_TOOLS"
3. Click on a version to open the **View Version** modal
4. The modal displays: model configuration, orchestrator instructions, agents-as-tools table (runtime ID, endpoint, role), additional tools (if any), and conversation manager

## Creating a New Version

To update an agents-as-tools configuration:

1. Select the agent in the **Agent Factory** table
2. Click **New version**
3. The wizard opens with the existing configuration pre-populated
4. Modify sub-agents, orchestrator instructions, or model settings as needed
5. Click **Create Runtime** to deploy the new version

## How It Works Under the Hood

1. The UI sends a `createAgentCoreRuntime` mutation with `architectureType: AGENTS_AS_TOOLS` and the orchestrator config as `configValue`
2. The Agent Factory Resolver validates the config against `OrchestratorConfiguration` (Pydantic) and verifies all referenced runtime IDs exist
3. The Step Function invokes the Create Runtime Version Lambda, which selects the agents-as-tools Docker container (`docker-agents-as-tools/`)
4. At runtime, the container's `data_source.py` loads the orchestrator configuration from DynamoDB
5. `factory.py` creates a Strands `Agent` with the orchestrator's model and instructions, then wraps each sub-agent as an `InvokeSubAgentTool`:
   - Each sub-agent becomes a tool named `invoke_<runtimeId>`
   - The tool description includes the sub-agent's role, telling the orchestrator when to use it
   - When invoked, the tool calls the AgentCore invoke API to run the sub-agent and returns its response
6. The orchestrator agent reasons about the user's request, decides which sub-agent tools to call (and with what input), and synthesizes the final response

### Key implementation detail: Context passing

Sub-agents have **no access to the conversation history**. When the orchestrator invokes a sub-agent tool, it must pass all relevant context in the `query` parameter. The tool's schema enforces this:

> *"Complete, self-contained prompt to send to the sub-agent. IMPORTANT: You MUST include ALL relevant details, parameters, and data from the user's request that the sub-agent needs to fulfill its role."*

This is why clear orchestrator instructions are essential — the orchestrator must know to forward complete context to each sub-agent.

## Best Practices

### Writing effective role descriptions

The role is the primary mechanism the orchestrator uses to decide which sub-agent to invoke. Good roles are:

- **Specific**: "Handles flight and hotel booking research for specific destinations and dates" (not "Helps with travel")
- **Action-oriented**: Describe what the agent *does*, not what it *is*
- **Boundary-clear**: Make it obvious when this agent should (and shouldn't) be invoked

### Writing effective orchestrator instructions

- **List all sub-agents** and describe when to use each one
- **Define a delegation strategy** — should the orchestrator call all agents or only relevant ones?
- **Emphasize context passing** — remind the orchestrator to include all relevant details in each sub-agent call
- **Describe synthesis** — tell the orchestrator how to combine sub-agent responses into a final answer

### When to use agents-as-tools vs. other patterns

| Pattern | Best for |
|---|---|
| **Single Agent** | Simple tasks with direct tool access |
| **Agents as Tools** | Dynamic delegation where the orchestrator decides which specialists to invoke based on the request |
| **Swarm** | Collaborative workflows where agents hand off conversations to each other |
| **Graph** | Predefined workflows with fixed execution paths and conditional routing |

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Orchestrator doesn't invoke sub-agents | Role descriptions are too vague | Make roles more specific and descriptive |
| Sub-agent returns incomplete responses | Orchestrator didn't pass enough context | Update orchestrator instructions to emphasize passing complete context |
| Wrong sub-agent invoked | Role descriptions overlap | Make roles more distinct with clearer boundaries |
| Agent not appearing in dropdown | Agent hasn't finished creating | Wait for the agent to reach "Ready" status |
| Creation fails with validation error | Empty tools/toolParameters mismatch | Ensure either both tools and toolParameters are provided, or neither |
| Sub-agent timeout | Complex sub-agent taking too long | The sub-agent has its own timeout settings; increase them if needed |
| "Runtime not found" error | Referenced runtime ID doesn't exist | Verify the sub-agent is deployed and has a valid endpoint |
