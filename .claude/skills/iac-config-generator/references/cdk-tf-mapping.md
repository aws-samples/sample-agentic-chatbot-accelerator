# CDK ↔ Terraform field mapping

Use this when you've decided what to enable and you need to render the same configuration in both formats. The two outputs must describe the same deployment — not the same syntax.

When in doubt about exact HCL/YAML syntax, look at:
- CDK reference: `cache/configs/config-kb.yaml` (a real working example with KB enabled).
- Terraform reference: `iac-terraform/terraform.tfvars.example` (a real working example with all blocks commented).

## Naming convention

| CDK YAML | Terraform HCL |
|---|---|
| `camelCase` | `snake_case` |
| `key: value` | `key = value` |
| string `"value"` or `value` | string `"value"` (quotes required for strings) |
| list `[a, b]` or block-form | list `[a, b]` |
| nested object | inline `{ }` block |
| optional missing → omit key | optional missing → leave variable at default (often `null`) — usually means commenting the block out in `terraform.tfvars` |
| multiline string `\|` | heredoc `<<-EOT … EOT` |

## Top-level mapping

| CDK | Terraform | Notes |
|---|---|---|
| `prefix` | `prefix` | Direct. |
| (no CDK field) | `aws_region` | TF only — CDK reads region from CLI/profile. |
| (no CDK field) | `environment` | TF only — combined with `prefix`. |
| (no CDK field) | `aws_profile` | TF only. |
| (no CDK field) | `lambda_architecture` | TF only — `arm64` default. |
| `bedrockAccessRoleArn` | `bedrock_access_role_arn` | Cross-account Bedrock STS role. |
| `enableGeoRestrictions`, `allowedGeoRegions` | (no TF mirror today) | CDK only. Skip in TF. |
| `supportedModels` | `supported_models` | Same map shape; quote display names with spaces in HCL. |
| `rerankingModels` | (no TF mirror) | CDK only. Skip in TF. |
| `toolRegistry` | `tool_registry` | Field rename: `invokesSubAgent` → `invokes_sub_agent`. |
| `mcpServerRegistry` | `mcp_server_registry` | Field renames: `runtimeId` → `runtime_id`, `gatewayId` → `gateway_id`. CDK supports `url` + `authType` for direct HTTP MCP; TF variable does not — flag a gap if needed. |
| `ingestionLambdaProps` | (no TF mirror — defaults bake in) | CDK only. |
| `agentCoreObservability` | `observability` (different name!) | `enableTransactionSearch` → `enable_transaction_search`; `indexingPercentage` → `indexing_percentage`. |
| `dataProcessingParameters` | `data_processing` (different name!) | All field-by-field mapping in [feature-matrix.md](feature-matrix.md). |
| `knowledgeBaseParameters` | `knowledge_base` (different name!) | Chunking strategy is structured differently — see below. |
| `agentRuntimeConfig` | `agent_runtime_config` | Heredoc for `instructions`. |
| `evaluatorConfig` | `evaluator_config` | Heredoc for each rubric. |
| `experimentsConfig` | `experiments_config` | Three-mode flag — see feature-matrix.md. |
| `stateClassRegistry`, `deterministicNodeRegistry`, `structuredOutputRegistry` | (no TF mirror) | CDK only. |

## Chunking strategy — the format diverges

CDK nests typed sub-objects under the strategy:

```yaml
knowledgeBaseParameters:
  chunkingStrategy:
    type: HIERARCHICAL
    hierarchicalChunkingProps:
      overlapTokens: 60
      maxParentTokenSize: 1500
      maxChildTokenSize: 300
```

Terraform flattens to a string + a separate sibling block:

```hcl
knowledge_base = {
  chunking_strategy = "HIERARCHICAL"
  hierarchical_chunking_config = {
    overlap_tokens        = 60
    max_parent_token_size = 1500
    max_child_token_size  = 300
  }
  # …
}
```

Same for `FIXED_SIZE` (`fixedChunkingProps` ↔ `fixed_chunking_config`) and `SEMANTIC` (`semanticChunkingProps` ↔ `semantic_chunking_config`). When generating TF, only emit the one config block matching the chosen strategy.

## Multiline strings

CDK YAML:
```yaml
agentRuntimeConfig:
  instructions: |
    You are a helpful AI assistant.
    Be concise.
```

Terraform HCL:
```hcl
agent_runtime_config = {
  instructions = <<-EOT
    You are a helpful AI assistant.
    Be concise.
  EOT
}
```

The `<<-EOT` form (with the dash) lets you indent the heredoc body for readability — Terraform strips the leading whitespace based on the closing `EOT` line. Always use `<<-EOT`, never `<<EOT`, in generated configs.

## Optional / disabled features — emit nothing, not empty

For features the user did **not** enable:

- **CDK**: omit the key entirely. Don't emit `knowledgeBaseParameters: null` or `experimentsConfig: {}` — the loader treats absence as "feature off".
- **Terraform**: leave the variable at its `default` from `variables.tf`. In `terraform.tfvars` this means commenting the block out (preferred — keeps the user oriented) or omitting it. Never write `experiments_config = null` if the variable's default is already `null` — it's noise.

The one exception is `experiments_config = {}` in TF, which is the documented signal for "enabled with auto-VPC". Same in CDK: `experimentsConfig: {supportedModels: …}` is "enabled". Don't shorten this to `experimentsConfig: {}` in CDK — `supportedModels` is required when enabled.

## Tool registry rendering

CDK YAML:
```yaml
toolRegistry:
  - name: "invoke_subagent"
    description: "Invoke a sub-agent…"
    invokesSubAgent: true
```

Terraform HCL:
```hcl
tool_registry = [
  {
    name              = "invoke_subagent"
    description       = "Invoke a sub-agent…"
    invokes_sub_agent = true
  }
]
```

Note the alignment in HCL — Terraform's `terraform fmt` would reformat to aligned `=` anyway. Generating it pre-aligned is friendlier.

## MCP registry rendering

CDK supports three discriminated union shapes (`runtimeId`, `gatewayId`, or `url`+`authType`). Terraform's variable today is a single object with all fields `optional()` — the `url`/`authType` form is unsupported in TF.

If the user wants a direct HTTP MCP server, emit the CDK form normally and **flag a gap** in the report ("Terraform doesn't support `url`/`authType` MCP entries today; this server is omitted from `terraform.tfvars`. Use the AgentCore Runtime or Gateway form, or extend `iac-terraform/variables.tf`.").

## Sanity checklist before writing

1. CDK YAML parses (no tabs, consistent indent, all maps have keys).
2. Terraform HCL parses (`=` between keys and values, strings quoted, lists with commas).
3. Cross-references resolve: every name in `agentRuntimeConfig.tools` is in `toolRegistry`, every name in `agentRuntimeConfig.mcpServers` is in `mcpServerRegistry`.
4. `dataSourcePrefix` matches between Data Processing and Knowledge Base (in *both* files).
5. The same set of features is enabled in both files. (E.g., if you enable Experiments in CDK but forgot to uncomment `experiments_config = {}` in TF, that's a sync bug.)
