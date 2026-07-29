# Bedrock Mantle Models

The accelerator can run any model served on the AWS **`bedrock-mantle`** endpoint — the fast-moving open-source tail (Gemma, Qwen, DeepSeek, GLM, Kimi, …) plus the newest OpenAI and Anthropic models — in addition to the Bedrock **Converse** models it has always supported. This page lists which models work and how routing picks the protocol for each.

You do **not** configure a protocol. You put a model id in `supportedModels` (see [How to Deploy](./how-to-deploy.md)) or pick one in the Agent Factory, and `BaseAgentFactory.create_model` routes it automatically. The mechanism is [ADR-0003](../adr/0003-mantle-provider-dispatch.md); this page is the model-by-model companion.

## How routing works

`create_model` performs an **exact-id membership test** against the live Mantle catalog (`GET /v1/models`), then dispatches by provider:

| Condition                                      | Strands class                  | Mantle surface                   |
| ---------------------------------------------- | ------------------------------ | -------------------------------- |
| id **not** in the Mantle catalog               | `BedrockModel`                 | Converse (unchanged)             |
| on Mantle, `anthropic.*`                       | `AnthropicModel`               | Messages — `…/anthropic`         |
| on Mantle, `openai.gpt-5.*`                    | `OpenAIResponsesModel`         | Responses — `…/openai/v1`        |
| on Mantle, `google.gemma-4-*` / `xai.grok-4.*` | `OpenAIModel` (+`client_args`) | Chat Completions — `…/openai/v1` |
| on Mantle, anything else                       | `OpenAIModel`                  | Chat Completions — `…/v1`        |

You own the model id. An id that matches a Mantle-listed model routes to Mantle; a cross-region inference profile or Converse-form id (e.g. `us.anthropic.claude-…`, `…-v1:0`) is absent from the Mantle catalog and routes to Converse exactly as before. There is no id normalization — match the id verbatim as the catalog reports it (short form, e.g. `openai.gpt-oss-20b`, **not** `openai.gpt-oss-20b-1:0`).

## Supported models (us-east-1, verified 2026-07-28)

The tables below reflect a live sweep of the `bedrock-mantle` catalog in us-east-1 (55 models). Availability and the exact id list vary by Region and change as AWS adds models — re-check `GET /v1/models` for the current set.

### Chat Completions — `/v1` (OpenAIModel)

The OSS tail and OpenAI open-weights models. These stream tokens and tool steps over the standard Chat Completions surface.

| Provider              | Model ids                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek              | `deepseek.v3.1`, `deepseek.v3.2`                                                                                                                                                                                                                                               |
| Google (Gemma 3)      | `google.gemma-3-4b-it`, `google.gemma-3-12b-it`, `google.gemma-3-27b-it`                                                                                                                                                                                                       |
| MiniMax               | `minimax.minimax-m2`, `minimax.minimax-m2.1`, `minimax.minimax-m2.5`                                                                                                                                                                                                           |
| Mistral               | `mistral.devstral-2-123b`, `mistral.magistral-small-2509`, `mistral.ministral-3-3b-instruct`, `mistral.ministral-3-8b-instruct`, `mistral.ministral-3-14b-instruct`, `mistral.mistral-large-3-675b-instruct`, `mistral.voxtral-mini-3b-2507`, `mistral.voxtral-small-24b-2507` |
| Moonshot              | `moonshotai.kimi-k2-thinking`, `moonshotai.kimi-k2.5`                                                                                                                                                                                                                          |
| NVIDIA                | `nvidia.nemotron-nano-9b-v2`, `nvidia.nemotron-nano-12b-v2`, `nvidia.nemotron-nano-3-30b`, `nvidia.nemotron-super-3-120b`                                                                                                                                                      |
| OpenAI (open-weights) | `openai.gpt-oss-20b`, `openai.gpt-oss-120b`, `openai.gpt-oss-safeguard-20b`, `openai.gpt-oss-safeguard-120b`                                                                                                                                                                   |
| Qwen                  | `qwen.qwen3-32b`, `qwen.qwen3-235b-a22b-2507`, `qwen.qwen3-coder-30b-a3b-instruct`, `qwen.qwen3-coder-480b-a35b-instruct`, `qwen.qwen3-coder-next`, `qwen.qwen3-next-80b-a3b-instruct`, `qwen.qwen3-vl-235b-a22b-instruct`                                                     |                                                                                                                                                                                                                                                     |
| Z.ai                  | `zai.glm-4.6`, `zai.glm-4.7`, `zai.glm-4.7-flash`, `zai.glm-5`                                                                                                                                                                                                                 |

### Chat Completions — `/openai/v1` passthrough (OpenAIModel + client_args)

These support Chat Completions but are served **only** on the `/openai/v1`
passthrough; requesting them on `/v1` returns
`400 "model isn't supported on this route"`. `create_model` routes the
`google.gemma-4-*` and `xai.grok-4.*` prefixes here automatically.

| Provider         | Model ids                                                            |
| ---------------- | -------------------------------------------------------------------- |
| Google (Gemma 4) | `google.gemma-4-e2b`, `google.gemma-4-26b-a4b`, `google.gemma-4-31b` |
| xAI              | `xai.grok-4.3` ⚠️ see below                                           |

> ⚠️ **`xai.grok-4.3` is routed correctly but not offered in the catalog.** Plain
> completions work; **tool calls hang**. xAI returns tool calls as a *complete*
> response and expects a fresh API call carrying the results, while Strands pauses
> a single stream and resumes it in place — see
> [strands-agents/harness-sdk#1340](https://github.com/strands-agents/harness-sdk/issues/1340).
> The tool executes and the stream never resumes, so the caller sees a read
> timeout rather than an error. Because every agent in this accelerator is
> tool-capable, the model is omitted from `supported-models.ts`/`.tf` rather than
> shipped as an option that hangs. Its reasoning-capability entry is retained, so
> re-adding it to the catalog is the only change needed once #1340 lands.

### Responses API — `/openai/v1` (OpenAIResponsesModel)

The OpenAI proprietary line. Served **only** via the Responses API; they reject
Chat Completions.

| Provider | Model ids                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI   | `openai.gpt-5.4`, `openai.gpt-5.5`, `openai.gpt-5.6-luna`, `openai.gpt-5.6-sol`, `openai.gpt-5.6-terra` |

### Anthropic Messages — `/anthropic` (AnthropicModel)

The newest Claude models on Mantle. Older Claude ids reachable via a Bedrock inference profile stay on the Converse path (below) instead.

| Provider  | Model ids                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | `anthropic.claude-haiku-4-5`, `anthropic.claude-sonnet-5`, `anthropic.claude-opus-4-7`, `anthropic.claude-opus-4-8`, `anthropic.claude-opus-5`, `anthropic.claude-fable-5` |

### Converse (BedrockModel) — everything else

Any id **not** in the Mantle catalog keeps the original Bedrock Converse path,
unchanged: Nova (`amazon.nova-*`), older Claude via cross-region inference
profiles (`us.anthropic.claude-…`), and any other Converse-integrated model. This
path keeps prompt caching, reasoning `additionalModelRequestFields`, stop
sequences, and cross-account `boto_session` support — none of which apply on the
Mantle branches.

## Limitations & notes

- **Structured outputs** are **not** supported for Claude-on-Mantle (the Messages surface `400`s on `output_config.format`). Use a Converse-form Claude id if you need structured output.
- **Voice / Nova Sonic** (BidiAgent) is not on Mantle.
- **`temperature`** is not sent on the Anthropic Messages branch or the OpenAI Responses branch — the newest models on those surfaces reject a non-default sampling value.
- **The `/openai/v1`-Chat-Completions set is a maintained prefix list** (`_MANTLE_OPENAI_V1_CHAT_PREFIXES` in `base_factory.py`). The serving path is model metadata the catalog does not expose (`/openai/v1/models` `404`s and `/v1/models` lists every model regardless of path), so there is no dynamic signal to route on. When AWS adds a new family that Chat-Completions-serves on `/openai/v1`, add its prefix there and check its AWS model card.
- **Regional & catalog drift.** The lists above are a point-in-time snapshot of us-east-1. Model availability differs by Region and changes on AWS releases; the routing is dynamic (catalog membership), so new OSS models on `/v1` work with no code change — but a genuinely new `/openai/v1` family needs a prefix update as noted above.

## IAM

The AgentCore runtime execution role needs `bedrock-mantle:ListModels` (catalog fetch), `bedrock-mantle:CreateInference`, and `bedrock-mantle:CallWithBearerToken` in addition to the standard `bedrock:InvokeModel*` grants. These are wired in the CDK (`iac-cdk/lib/agent-core/index.ts`) and Terraform (`iac-terraform/modules/agent_core/iam.tf`) execution-role definitions.
