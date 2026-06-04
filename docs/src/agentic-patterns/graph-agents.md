# Graph Agents

This guide explains how to create and test graph agents using the Agentic Chatbot Accelerator. Graph agents allow you to compose existing agents into stateful LangGraph workflows with directed edges, conditional routing, parallel fan-out, and deterministic transformations.

## Overview

A graph agent consists of:

- **Graph Nodes**: Four kinds of nodes that can participate in the workflow:
  - **Agent nodes** — invoke existing single or swarm agents
  - **Fork nodes** — pass-through nodes that fan out to multiple parallel branches
  - **Dynamic Map nodes** — runtime fan-out using LangGraph `Send()` over a list
  - **Deterministic nodes** — pure-Python transformation functions (no LLM call)
- **Graph Edges**: Directed connections between nodes defining the execution flow (unconditional or conditional)
- **Entry Point**: The node that receives the initial user message
- **Orchestrator Settings**: Controls for execution limits (max iterations, timeouts)
- **State Schema**: Shared state that flows through the graph — either flat custom fields or a predefined state class with typed structures and reducers

Unlike swarm agents where agents hand off conversations dynamically, graph agents follow a predefined workflow. The execution path is determined by the graph structure and conditional edges. For example, a content pipeline might have a researcher → writer → reviewer flow, where the reviewer can loop back to the writer if revisions are needed.

### What's New

The graph engine now supports advanced pipeline patterns:

| Feature | Description |
|---------|-------------|
| **Fork nodes** | Static parallel fan-out — all outgoing edges from a fork execute in parallel |
| **Dynamic Map nodes** | Runtime fan-out — reads a list from state and spawns one branch per item via `Send()` |
| **Deterministic nodes** | Pure-Python reduce/transform steps (no LLM, no network) |
| **Predefined State Classes** | Complex TypedDict schemas with `Annotated` reducers for fan-in accumulation |
| **Per-node Prompt Templates** | Override the inherited prompt with `{variable}` placeholders |
| **Structured Output** | Sub-agent structured outputs propagate between nodes and appear in the final response |
| **Graph Preview** | Live React Flow visualization in the designer with auto-layout |

## Prerequisites

Before creating a graph agent, you need:

1. **At least one deployed agent** (single or swarm) with status "Ready" and a tagged endpoint (e.g. DEFAULT)
2. **An A2A twin runtime** for every agent referenced by an agent node. Single agents are deployed as twin runtimes by default (one HTTP, one A2A) — you don't need to do anything extra. The graph container talks to sub-agents over A2A, so a referenced agent without a twin will fail validation at config-save time
3. **A capability description on each referenced sub-agent** (set on the sub-agent when you create it — see [Single Agent → Add an agent description](single-agent.md)). Graph routing is decided at config time by the edges you draw, not by the description, but the description is what operators read in the wizard and View Version modal when wiring nodes — so without it the graph topology is opaque
4. **The accelerator deployed** with the graph feature enabled (CDK/Terraform stack includes the graph container image)

## Step-by-Step: Creating a Graph Agent

### 1. Create the individual agents first

Each agent node in the graph references an existing agent. Create them through the UI as you normally would:

1. Go to **Agent Factory** → **Create Agent**
2. Select **Single Agent** (or **Swarm**) architecture
3. Configure each agent with its own instructions, model, and tools
4. **Fill in the Agent Description** — this isn't what routes traffic in a graph (edges do that), but it's what shows up next to the agent name in the node-picker dropdown and in the View Version modal. A good description makes the graph topology self-documenting; an empty description makes it nearly impossible to remember what each node does six months later.
5. Wait for each agent to reach "Ready" status

### 2. Create the graph agent

1. Go to **Agent Factory** → **Create Agent**
2. In the **Architecture Type** step, select **Graph**
3. Enter a name for the graph agent (e.g. `content_pipeline`)

### 3. Design the graph

In the **Graph Design** step:

#### Choose node kind

Use the **Node Kind** dropdown at the top of the Nodes section to select what type of node to add:

- **Agent** — invoke an existing AgentCore runtime
- **Deterministic** — run a registered pure-Python function (no LLM)
- **Fork** — fan-out pass-through for parallel branches
- **Dynamic Map** — `Send()`-based parallel fan-out over a runtime list

#### Add agent nodes

1. Select "Agent" as the node kind
2. Use the agent dropdown to select an existing agent
3. Each node gets a unique ID based on the agent name
4. You can add the same agent multiple times (each gets a distinct ID)

#### Add fork nodes

1. Select "Fork" as the node kind
2. Enter a unique node ID (e.g. `fan_out`)
3. Click **Add Fork**

#### Add dynamic map nodes

1. Select "Dynamic Map" as the node kind
2. Fill in:
   - **Node ID** — unique identifier (e.g. `dynamic_fan_out`)
   - **Source Key** — state field containing the list to iterate (e.g. `templates`)
   - **Target Node** — which node each `Send()` dispatches to
   - **Item State Key** — state field set per-branch with each item (e.g. `template_name`)
3. Click **Add Dynamic Map**

#### Add deterministic nodes

1. Select "Deterministic" as the node kind
2. Choose from registered deterministic functions in the dropdown
3. These are configured via `deterministicNodeRegistry` in the CDK/Terraform config

#### Configure node settings

Click the **expand** (↓) icon on any node row to access per-node settings:

- **Label** — display name
- **Endpoint** — which endpoint/version to invoke (agent nodes)
- **Prompt Template** — optional override with `{variable}` placeholders (agent nodes)
- **Dynamic Map Config** — source key, target node, item state key (dynamic_map nodes)

#### Set the entry point

Click the **Set** button next to the node that should receive the initial user message. Exactly one entry point is required.

#### Add edges

1. Select a **Source Node** and **Target Node** from the dropdowns
2. For the final node in your workflow, set the target to **__end__**
3. Toggle **Conditional** to add a condition — enter a keyword that must appear in the source node's output for this edge to be followed
4. Click **Add Edge**

> **Note**: Dynamic map nodes don't need explicit outgoing edges — they handle fan-out implicitly via `Send()`.

#### Define state schema

Choose between two modes:

- **Custom** — define flat fields with primitive types (str, int, dict, list, etc.)
- **Predefined State Class** — select a registered class with typed structures and Annotated reducers (e.g. for fan-in accumulation)

When a predefined class is selected, the UI shows its description and field list.

#### Graph preview

Once you have nodes and edges, a **live graph visualization** appears showing the topology with:
- Color-coded nodes (agent=purple, deterministic=green, fork=blue, dynamic_map=purple, END=red)
- Entry point badges
- Conditional edges (dashed) vs unconditional (solid)
- Toggle between vertical and horizontal layout

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

## Example 1: Content Review Pipeline (Linear)

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

## Example 2: Conditional Review Loop

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

## Example 3: Parallel Fork Pipeline

A pipeline using a **fork node** to run two agents in parallel, then merge their outputs.

### Graph structure

```
fan_out ──→ technical_writer ──→ __end__
        ──→ creative_writer  ──→ __end__
```

Both branches execute simultaneously. The final response contains **both outputs concatenated** with a `---` separator, so you see both perspectives in a single response.

### Step 1 — Create two single agents

| Agent Name | Role | Instructions |
|---|---|---|
| `technical_writer` | Technical content | "You are a technical writer. Write accurate, structured technical content with code examples where appropriate. Focus on clarity and precision." |
| `creative_writer` | Creative content | "You are a creative storyteller. Write engaging, narrative-driven content that makes technical concepts accessible and fun. Use metaphors and storytelling." |

### Step 2 — Create the graph

1. **Agent Factory** → **Create Agent** → **Graph**
2. Name: `parallel_writers`
3. Add a **Fork** node:
   - Select "Fork" as node kind
   - Enter ID: `fan_out`
   - Click **Add Fork**
4. Add **Agent** nodes: `technical_writer`, `creative_writer`
5. Entry Point: `fan_out`
6. Add edges:
   - `fan_out` → `technical_writer` (unconditional)
   - `fan_out` → `creative_writer` (unconditional)
   - `technical_writer` → `__end__` (unconditional)
   - `creative_writer` → `__end__` (unconditional)

### Step 3 — Test it

```
User: Explain how containers work in cloud computing

→ fan_out: [passes the message to both branches simultaneously]
→ technical_writer: [writes a precise technical explanation with Docker/K8s examples]
→ creative_writer: [writes a narrative explanation using shipping container metaphors]
→ Final response (both outputs concatenated):

[Technical writer's explanation about Docker, namespaces, cgroups...]

---

[Creative writer's narrative using shipping container metaphors...]
```

> **Note**: The graph engine automatically detects fork/dynamic_map nodes and applies a concatenation reducer to the `messages` field. This means parallel branches' outputs are combined — no predefined state class needed for simple fork patterns.

### Graph configuration JSON

```json
{
  "nodes": [
    { "id": "fan_out", "nodeType": "fork", "endpointName": "DEFAULT", "label": "fan_out" },
    { "id": "technical_writer", "agentName": "technical_writer", "endpointName": "DEFAULT" },
    { "id": "creative_writer", "agentName": "creative_writer", "endpointName": "DEFAULT" }
  ],
  "edges": [
    { "source": "fan_out", "target": "technical_writer" },
    { "source": "fan_out", "target": "creative_writer" },
    { "source": "technical_writer", "target": "__end__" },
    { "source": "creative_writer", "target": "__end__" }
  ],
  "entryPoint": "fan_out",
  "stateSchema": {},
  "orchestrator": {
    "maxIterations": 50,
    "executionTimeoutSeconds": 300,
    "nodeTimeoutSeconds": 120
  }
}
```

## Example 4: Map-Reduce Pipeline (Advanced)

A pipeline using **fork + deterministic reduce** for a map-reduce pattern. Two agents independently analyze the same input, and a deterministic Python function merges their outputs.

### Graph structure

```
fan_out ──→ agent_a ──┐
        ──→ agent_b ──┤
                      └──→ reduce ──→ __end__
```

### Prerequisites

This example requires:
1. A **predefined state class** registered in your config (e.g. `MapReducePipelineState`) with an `Annotated[list, operator.add]` reducer for the `partial_templates` field
2. A **deterministic node** registered (e.g. `merge_template_partials`) that merges the parallel outputs

These are configured in your CDK config (`iac-cdk/bin/config.yaml`):

```yaml
# Graph Pipeline Registries
stateClassRegistry:
    - key: "MapReducePipelineState"
      label: "Map-Reduce Template Assembly"
      description: "Parallel map phase with deterministic reduce merge."
      fields:
          - messages
          - partial_templates
          - merged_template

deterministicNodeRegistry:
    - key: "merge_template_partials"
      label: "Merge Template Partials"
      description: "Merges partial outputs from parallel branches."
```

And the corresponding Python code in `src/agent-core/docker-graph/src/states/`:

```python
# src/agent-core/docker-graph/src/states/my_pipeline.py
import operator
from typing import Annotated, TypedDict
from ..state_registry import register_state_class
from ..deterministic_node_registry import register_deterministic_node

def _last_value(current: str, new: str) -> str:
    return new

class MapReducePipelineState(TypedDict):
    messages: Annotated[str, _last_value]
    partial_templates: Annotated[list[dict], operator.add]
    merged_template: dict

register_state_class(
    key="MapReducePipelineState",
    cls=MapReducePipelineState,
    label="Map-Reduce Template Assembly",
    description="Parallel map phase with deterministic reduce merge.",
)

def merge_template_partials(state: dict) -> dict:
    partials = state.get("partial_templates") or []
    merged = {}
    for entry in partials:
        data = entry.get("data") or {}
        merged.update(data)
    return {
        "merged_template": merged,
        "messages": f"Merge complete: {len(merged)} fields combined from {len(partials)} sources.",
    }

register_deterministic_node(
    key="merge_template_partials",
    fn=merge_template_partials,
    label="Merge Template Partials",
    description="Merges partial outputs from parallel branches.",
)
```

Don't forget to import it in `src/agent-core/docker-graph/src/states/__init__.py`:
```python
from . import my_pipeline  # noqa: F401
```

### Step 1 — Create two single agents with structured output

Both agents **must be configured with structured output** so the graph engine can capture their results and pass them to the deterministic merge node. Without structured output, the merge function receives empty data.

| Agent Name | Role | Instructions |
|---|---|---|
| `agent_a` | Analyst A | "You are analyst A. Analyze the given topic from an economic perspective. Return your analysis as structured fields." |
| `agent_b` | Analyst B | "You are analyst B. Analyze the given topic from a technical perspective. Return your analysis as structured fields." |

**Structured Output Schema** (same for both agents):

| Field Name | Python Type | Description | Optional |
|---|---|---|---|
| `perspective` | `str` | The analysis perspective (e.g. "economic" or "technical") | No |
| `summary` | `str` | Brief summary of the analysis | No |
| `key_findings` | `str` | Comma-separated list of key findings | No |
| `risks` | `str` | Identified risks or challenges | Yes |
| `recommendations` | `str` | Recommendations based on the analysis | Yes |

Configure this in the **Structured Output** section when creating each single agent through the UI.

### Step 2 — Create the graph

1. **Agent Factory** → **Create Agent** → **Graph**
2. Name: `mapreduce_analysis`
3. **State Mode**: Select "Map-Reduce Template Assembly" (the predefined class)
4. Add a **Fork** node: `fan_out`
5. Add **Agent** nodes: `agent_a`, `agent_b`
6. Add a **Deterministic** node: select `merge_template_partials` → creates node `merge_template_partials`
7. Entry Point: `fan_out`
8. Add edges:
   - `fan_out` → `agent_a` (unconditional)
   - `fan_out` → `agent_b` (unconditional)
   - `agent_a` → `merge_template_partials` (unconditional)
   - `agent_b` → `merge_template_partials` (unconditional)
   - `merge_template_partials` → `__end__` (unconditional)

### Step 3 — Test it

```
User: Analyze the impact of AI on healthcare

→ fan_out: [fans out to both analysts]
→ agent_a: [economic analysis — costs, ROI, market size]
→ agent_b: [technical analysis — NLP for records, imaging AI, drug discovery]
→ merge_template_partials: [deterministic merge of both analyses]
→ Final response: merged analysis from both perspectives
```

### How it works

1. The fork node passes the user message to both branches simultaneously
2. Each agent node runs and appends its structured output to the `partial_templates` list (using the `Annotated[list, operator.add]` reducer for fan-in)
3. LangGraph waits for both branches to complete before running the reduce node
4. The deterministic `merge_template_partials` function combines the partial outputs without an LLM call
5. The merged result is returned as the final response

## Per-Node Prompt Templates

Agent nodes can override the inherited graph-level prompt using a **prompt template**:

```
Analyze the following from a {perspective} perspective: {messages}
```

Placeholders are interpolated from the combined graph state + invocation extra state. Unresolved placeholders are left as-is.

Configure this in the expanded node settings panel — the **Prompt Template** textarea.

**Use cases:**
- Give each parallel branch a different instruction while sharing the same agent
- Inject dynamic context (template names, file paths) into the prompt
- Customize behavior without creating separate agent configurations

## Structured Output

When sub-agents return structured output (JSON), the graph engine:

1. **Merges** matching SO fields into the graph state
2. **Propagates** all SO fields to downstream nodes via the invocation extra state
3. **Stores** the complete SO under `{node_id}_output`
4. **Includes** structured outputs in the final WebSocket response as `structuredOutput`

This enables multi-step pipelines where each node's structured output feeds into the next node's context.

## Viewing Graph Configuration

To inspect an existing graph agent's configuration:

1. Go to **Agent Factory**
2. Find the agent in the table — the **Architecture** column shows "GRAPH"
3. Click on a version to open the **View Version** modal
4. The modal displays: entry point, nodes table (with agent names, kinds, and endpoints), edges table (with conditions), and orchestrator settings

## Creating a New Version

To update a graph agent's configuration:

1. Select the graph agent in the **Agent Factory** table
2. Click **New version**
3. The wizard opens with the existing graph configuration pre-populated
4. Modify nodes, edges, or orchestrator settings as needed
5. Click **Create Runtime** to deploy the new version

## How It Works Under the Hood

1. The UI sends a `createAgentCoreRuntime` mutation with `architectureType: GRAPH` and the graph config as `configValue`
2. The Agent Factory Resolver validates the config against `GraphConfiguration` (Pydantic), verifies all referenced agents exist, and **rejects the config if any referenced agent has no A2A twin runtime** (graph nodes call sub-agents over A2A, so the twin is required)
3. The Step Function invokes the Create Runtime Version Lambda, which selects the graph Docker container (`docker-graph/`)
4. At runtime, the graph container's `data_source.py` loads the graph configuration from DynamoDB
5. `factory.py` compiles the configuration into a LangGraph `StateGraph`:
   - If `stateClass` is set, resolves the type from the **state registry** (supports `Annotated` reducers)
   - Otherwise builds a flat `TypedDict` from `stateSchema`
   - Each node is dispatched to the correct factory based on its kind (agent, fork, dynamic_map, deterministic)
6. When a message arrives:
   - `set_invocation_extra_state()` stores any caller-provided state
   - The compiled graph executes from the entry point
   - Agent nodes resolve the referenced sub-agent's A2A twin ARN from the agents summary table, then call it via SigV4-signed JSON-RPC `message/send` — the prompt rides as a `TextPart` and graph state as a sibling `DataPart`
   - The sub-agent's structured output (when configured) comes back as a `DataPart` artifact; the graph factory merges those fields into the graph state for downstream nodes
   - Fork nodes fan out, dynamic map nodes use `Send()`, deterministic nodes run Python functions
   - `get_invocation_extra_state()` extracts accumulated structured outputs
7. The final response (text + optional `structuredOutput`) is returned via WebSocket

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
| Empty or partial response | A2A response missing parts | Check the graph container logs in CloudWatch (`/aws/bedrock-agentcore/runtimes/`) — the graph factory walks `result.message.parts`, `artifacts[*].parts`, and `history[*].parts` so a malformed sub-agent response surfaces as an empty `A2AInvocationResult` |
| "Graph references agents without an A2A twin runtime" | Sub-agent was created before A2A twins were rolled out | Recreate the sub-agent so the A2A twin is provisioned (the agent-factory creates twins automatically for new SINGLE-architecture agents) |
| Timeout errors | Complex workflows exceeding defaults | Increase execution timeout and node timeout in orchestrator settings |
| Wrong node executed | Conditional routing matched wrong keyword | Use more distinctive condition keywords and check agent instructions |
| Infinite loop | Unconditional cycle in the graph | Add a conditional edge with an exit condition to break the cycle |
| "Graph references non-existent agents" | Agent was deleted after graph was configured | Recreate the missing agent or update the graph to remove the reference |
| Deterministic node not in dropdown | Node not registered in config | Add it to `deterministicNodeRegistry` in CDK/Terraform config and redeploy |
| State class not in dropdown | Class not registered in config | Add it to `stateClassRegistry` in CDK/Terraform config and register in Python |
| Parallel branches not merging | State doesn't use reducer | Use a predefined state class with `Annotated[list, operator.add]` for fan-in fields |
| Structured output not visible | Sub-agent doesn't return SO | Ensure the sub-agent's response includes `structuredOutput` in its final event |
