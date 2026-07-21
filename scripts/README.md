# Operator scripts

Out-of-band scripts run by an operator (not part of any Lambda or deploy). Run
with **least-privilege** AWS credentials — prefer a scoped role over admin.

## `port_config_to_bundles.py`

Migrates every existing agent's configuration from the legacy runtime config
table (`<prefix>-agentCoreRuntimeCfgTable`) into an AgentCore **configuration
bundle**, then backfills `BundleId` / `BundleArn` and rewrites
`QualifierToVersion.DEFAULT` in `<prefix>-agentCoreSummaryTable`.

**Run and verify this BEFORE the CDK infra task (T8) removes the runtime config
table** — once the table is gone the source data is unavailable.

### Idempotency

Keyed on the summary row's `BundleId`: if it is present and the bundle still
exists, the agent is skipped. Safe to re-run — a second run reports every agent
as already ported. A recorded-but-missing bundle is re-created.

### Usage

```bash
# Dry-run first — reports intended actions, mutates nothing.
python scripts/port_config_to_bundles.py --all --prefix <prefix> --region us-east-1 --dry-run

# Port every agent.
python scripts/port_config_to_bundles.py --all --prefix <prefix> --region us-east-1

# Port specific agents (repeatable).
python scripts/port_config_to_bundles.py --agent my-agent --agent other --prefix <prefix>

# Port the full version history (chained), not just the current DEFAULT.
python scripts/port_config_to_bundles.py --all --prefix <prefix> --full-history
```

`--prefix` may be supplied via the `ACA_PREFIX` env var. `--profile` selects an
AWS named profile. The region must be one of the confirmed bundle regions (the
script fails fast otherwise) and control-plane calls back off on throttling.

By default only the current DEFAULT version is ported (1:1 with the runtime
model); pass `--full-history` to chain every prior version into the bundle.

### Tests

```bash
cd scripts && uv run pytest tests/ -q
```
