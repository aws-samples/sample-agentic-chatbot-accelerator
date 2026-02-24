# Agent Evaluation

This guide covers the evaluation feature in the Agentic Chatbot Accelerator, which allows you to systematically test and validate your agent's responses using the Strands Evaluation SDK.

## Overview

The evaluation system enables you to:
- Create test cases with expected inputs and outputs
- Run evaluations against your deployed agents
- Use multiple evaluator types to assess different aspects of agent responses
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

The system supports five evaluator types from the Strands Evaluation SDK:

| Evaluator | Purpose | Requires Trajectory | Best For |
|-----------|---------|---------------------|----------|
| **OutputEvaluator** | Compares actual vs expected output using custom rubric | No | Exact answer validation |
| **HelpfulnessEvaluator** | Evaluates response helpfulness and user experience | Yes | User experience quality |
| **FaithfulnessEvaluator** | Evaluates if responses are grounded in conversation history, detecting hallucinations and unsupported claims | Yes | RAG scenarios |
| **ToolSelectionAccuracyEvaluator** | Validates tool selection decisions | Yes | Multi-tool agents |
| **ToolParameterAccuracyEvaluator** | Validates tool parameters accuracy | Yes | Complex tool usage |

## Recommended Evaluator Combinations

### For RAG-based Agents (Knowledge Base retrieval)
```
OutputEvaluator, HelpfulnessEvaluator, FaithfulnessEvaluator
```

### For Tool-based Agents (with custom tools)
```
OutputEvaluator, HelpfulnessEvaluator, ToolSelectionAccuracyEvaluator, ToolParameterAccuracyEvaluator
```

### For Simple Q&A Agents
```
OutputEvaluator, HelpfulnessEvaluator



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


## Best Practices

1. **Start simple**: Begin with `OutputEvaluator` and add more evaluators as needed
2. **Match evaluators to agent type**: Use tool evaluators for tool-based agents, faithfulness for RAG
3. **Provide clear expected outputs**: Evaluators compare against your expected output
4. **Test iteratively**: Run small test sets first to validate evaluator selection
5. **Monitor pass rates**: A consistent pass rate below 70% may indicate evaluator mismatch

## Related Resources

- [Strands Agents Evals SDK Documentation](https://strandsagents.com/latest/documentation/docs/user-guide/evals-sdk/)
- [API Reference](./api.md)
