# Agent Evaluation

This guide covers the evaluation feature in the Agentic Chatbot Accelerator, which allows you to systematically test and validate your agent's responses using the Strands Evaluation SDK.

## Overview

The evaluation system enables you to:
- Create test cases with expected inputs and outputs
- Run evaluations against your deployed agents (single or swarm)
- Use multiple evaluator types to assess different aspects of agent responses
- Evaluate agent-to-agent interactions in swarm configurations
- Track evaluation results and progress in real-time

## Configuration

The evaluation system is configured through `evaluatorConfig` in your `config.yaml` (or `config.ts` for defaults):

```yaml
evaluatorConfig:
    # Models available for LLM-based evaluations
    supportedModels:
        Claude Haiku 4.5: "[REGION-PREFIX].anthropic.claude-haiku-4-5-20251001-v1:0"
        Claude Sonnet 4.5: "[REGION-PREFIX].anthropic.claude-sonnet-4-5-20250929-v1:0"
        Nova 2 Lite: "[REGION-PREFIX].amazon.nova-2-lite-v1:0"

    # Score threshold (0.0-1.0) above which a test case is considered passed
    passThreshold: 0.8

    # Default rubrics for each evaluator type (optional)
    defaultRubrics:
        OutputEvaluator: |
            Evaluate the response based on:
            1. Accuracy - Is the information correct compared to expected output?
            2. Completeness - Does it fully answer the question?
            3. Clarity - Is it easy to understand?

            Score 1.0 if all criteria are met excellently.
            Score 0.5 if some criteria are partially met.
            Score 0.0 if the response is inadequate.
        TrajectoryEvaluator: |
            Evaluate the agent's action sequence based on:
            1. Efficiency - Did the agent take the most direct path to achieve the goal?
            2. Correctness - Were the right tools selected for each step?
            3. Order - Were actions performed in a logical sequence?
            4. Completeness - Were all necessary steps included?

            Score 1.0 if the trajectory was optimal.
            Score 0.5 if the trajectory achieved the goal with minor inefficiencies.
            Score 0.0 if the trajectory was significantly flawed.
        InteractionsEvaluator: |
            Evaluate the interaction based on:
            1. Correct node execution order
            2. Proper dependency handling
            3. Clear message communication

            Score 1.0 if all criteria are met.
            Score 0.5 if some issues exist.
            Score 0.0 if interaction is incorrect.
```

## Architecture

```
AppSync → EvaluationResolver → SQS Queue → EvaluationExecutor → DynamoDB/S3
```

1. **EvaluationResolver Lambda**: Handles CRUD operations and queues test cases
2. **SQS Queue**: Provides throttling protection and retry logic (configurable concurrency)
3. **EvaluationExecutor Lambda**: Processes individual test cases and runs evaluators
4. **DynamoDB**: Stores evaluation metadata and progress
5. **S3**: Stores detailed evaluation results

## Available Evaluators

The system supports nine evaluator types — eight from the Strands Evaluation SDK plus one custom evaluator:

| Evaluator | Purpose | Requires Rubric | Requires Trajectory | Best For |
|-----------|---------|-----------------|---------------------|----------|
| **OutputEvaluator** | Compares actual vs expected output using custom rubric | Yes | No | Exact answer validation |
| **HelpfulnessEvaluator** | Evaluates response helpfulness and user experience | No | Yes | User experience quality |
| **FaithfulnessEvaluator** | Evaluates if responses are grounded in conversation history | No | Yes | RAG scenarios |
| **GoalSuccessRateEvaluator** | Evaluates if all user goals were achieved (binary: 1.0=success, 0.0=failure) | No | No | Goal completion tracking |
| **TrajectoryEvaluator** | Assesses sequence of actions/tool calls taken by an agent | Yes | Yes | Workflow optimization |
| **ToolSelectionAccuracyEvaluator** | Validates tool selection decisions | No | Yes | Multi-tool agents |
| **ToolParameterAccuracyEvaluator** | Validates tool parameters accuracy | No | Yes | Complex tool usage |
| **InteractionsEvaluator** | Evaluates agent-to-agent handoffs and interactions (swarm only) | Yes | Yes | Swarm agents |
| **StructuredOutputEvaluator** | Deterministic field-by-field JSON comparison of structured output (no LLM needed) | No | No | Structured output validation |

## Recommended Evaluator Combinations

### For RAG-based Agents (Knowledge Base retrieval)
```
OutputEvaluator, HelpfulnessEvaluator, FaithfulnessEvaluator
```

### For Tool-based Agents (with custom tools)
```
OutputEvaluator, HelpfulnessEvaluator, TrajectoryEvaluator, ToolSelectionAccuracyEvaluator, ToolParameterAccuracyEvaluator
```

### For Simple Q&A Agents
```
OutputEvaluator, HelpfulnessEvaluator
```

### For Agents with Structured Output (JSON fields)
```
StructuredOutputEvaluator, OutputEvaluator



## Pass/Fail Logic

- **Pass threshold**: Configurable via `passThreshold` in `config.yaml`
- **Overall pass**: Based on **average score** across all evaluators
- **Individual evaluators**: Each produces a score from 0.0 to 1.0

Example (with passThreshold: 0.8):
```
OutputEvaluator: 100%
HelpfulnessEvaluator: 83%
Average: 91.5% → PASSED (>= 80%)
```

## Concurrency and Throttling

The SQS-based architecture provides built-in protection against:
- Bedrock model throttling
- AgentCore runtime session limits

Default configuration:
- **Batch size**: 1 (one test case per Lambda invocation)
- **Max concurrency**: 50 (configurable in `evaluation-api.ts`)

To adjust concurrency:
```typescript
evaluationExecutor.addEventSource(
    new SqsEventSource(evaluationQueue, {
        batchSize: 1,
        maxConcurrency: 50,  // Adjust this value
        reportBatchItemFailures: true,
    })
);
```


## Test Case Format

### Single Agent Test Cases

```json
[
  {
    "name": "weather-query",
    "input": "What is the weather in London?",
    "expected_output": "The current weather in London is...",
    "expected_trajectory": ["get_weather_forecast"],
    "metadata": { "category": "weather" }
  }
]
```

### Structured Output Test Cases (for StructuredOutputEvaluator)

For agents that return structured JSON output (e.g., extracted fields like `aws_services`, `links`), use `StructuredOutputEvaluator` with a structured `expected_output`. The evaluator compares each field deterministically — no LLM is required.

**Semantics:**
- **Non-null values**: The actual output must contain the field with an identical value (exact match for strings, order-insensitive comparison for lists).
- **Null values**: The field must be **absent** from the actual output or explicitly `null`. This is the "null-means-absent" convention.
- **Extra fields**: Fields present in the actual output but not in the expected output are ignored.

The `expected_output` field accepts both a **dict** (recommended) or a **JSON string**:

```json
[
  {
    "name": "aws-question-0001",
    "input": "What is Bedrock?",
    "expected_output": {
      "aws_services": ["Amazon Bedrock"]
    },
    "metadata": { "category": "aws"}
  }
]
```

> **Note**: `StructuredOutputEvaluator` uses the agent's `structuredOutput` dict (returned alongside the text response), not the text response itself. This means you can combine it with `OutputEvaluator` — one checks the structured fields, the other evaluates the natural language response.

### Test Cases with Agent State

For agents whose tools rely on **agent state** (e.g. S3 URI references for document processing), you can pass a `state` field in each test case. The value must be a **stringified JSON object**.

The state is forwarded to the agent runtime and becomes available via `tool_context.agent.state` inside tools.

```json
[
  {
    "name": "internal-doc-summary",
    "input": "Summarize the key findings from this internal architecture review document.",
    "expected_output": "The architecture review recommends migrating to a serverless-first approach...",
    "state": "{\"s3_bucket\":\"your-bucket\",\"document_s3_key\":\"reviews/2026-q1-architecture-review.pdf\"}",
    "expected_trajectory": ["summarize_document"],
    "metadata": { "category": "document-processing" }
  }
]
```

> **Note**: The `state` field is optional. Test cases without `state` continue to work exactly as before.

### Swarm Agent Test Cases (with expected_interactions)

For `InteractionsEvaluator`, use the `expected_interactions` field to define the expected agent-to-agent handoff sequence:

```json
[
  {
    "name": "software-dev-workflow",
    "input": "Design and implement a simple REST API for a todo app",
    "expected_trajectory": ["researcher", "architect", "coder", "reviewer"],
    "expected_interactions": [
      { "node_name": "researcher", "dependencies": [], "messages": "I've completed the research phase and handed off to the architect" },
      { "node_name": "architect", "dependencies": ["researcher"], "messages": "I've completed a comprehensive system architecture design for the TODO app REST API" },
      { "node_name": "coder", "dependencies": ["architect"], "messages": "I've successfully completed the implementation of the TODO app REST API" },
      { "node_name": "reviewer", "dependencies": ["coder"], "messages": "I'll conduct a comprehensive code review of the TODO app REST API implementation" }
    ],
    "metadata": { "category": "workflow" }
  }
]
```

| Field | Description | Used By |
|-------|-------------|---------|
| `name` | Test case identifier | All evaluators |
| `input` | User input/question | All evaluators |
| `expected_output` | Expected agent response (string or dict for structured output) | OutputEvaluator, StructuredOutputEvaluator |
| `state` | Stringified JSON object passed as agent state (optional) | Agents with state-dependent tools |
| `expected_trajectory` | Expected sequence of tool/agent names | TrajectoryEvaluator |
| `expected_interactions` | Expected agent-to-agent handoffs (swarm only) | InteractionsEvaluator |
| `metadata` | Additional test case metadata | Filtering/categorization |

## Evaluator Compatibility by Agent Type

| Evaluator | Single Agent | Swarm Agent |
|-----------|-------------|-------------|
| OutputEvaluator | ✅ | ✅ |
| HelpfulnessEvaluator | ✅ | ✅ |
| FaithfulnessEvaluator | ✅ | ✅ |
| GoalSuccessRateEvaluator | ✅ | ✅ |
| TrajectoryEvaluator | ✅ (tool calls) | ✅ (agent nodes) |
| ToolSelectionAccuracyEvaluator | ✅ | ✅ |
| ToolParameterAccuracyEvaluator | ✅ | ✅ |
| InteractionsEvaluator | ❌ | ✅ |
| StructuredOutputEvaluator | ✅ | ❌ |

> **Note**: `InteractionsEvaluator` is specifically designed for swarm agents as it evaluates agent-to-agent handoffs, which don't exist in single agent configurations.

## Best Practices

1. **Start simple**: Begin with `OutputEvaluator` and add more evaluators as needed
2. **Match evaluators to agent type**: Use tool evaluators for tool-based agents, faithfulness for RAG
3. **Use InteractionsEvaluator for swarms**: This evaluator is purpose-built for multi-agent workflows
4. **Provide clear expected outputs**: Evaluators compare against your expected output
5. **Define expected_trajectory for workflow validation**: Use this with `TrajectoryEvaluator` to verify action sequences
6. **Test iteratively**: Run small test sets first to validate evaluator selection
7. **Monitor pass rates**: A consistent pass rate below 70% may indicate evaluator mismatch
8. **Use StructuredOutputEvaluator for JSON outputs**: For agents that return structured data (e.g., extracted `loop_id`, `template_tags`), this evaluator provides deterministic field-level comparison without LLM costs. Use `null` in `expected_output` to assert a field should be absent.

## Related Resources

- [Strands Agents Evals SDK Documentation](https://strandsagents.com/latest/documentation/docs/user-guide/evals-sdk/quickstart/)
- [Swarm Agents Guide](./swarm-agents.md)
- [API Reference](./api.md)
