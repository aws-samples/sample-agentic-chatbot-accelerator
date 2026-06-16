# Update semantics — read-modify-write

There is **no `updateAgentCoreRuntime` mutation.** Updating an agent means re-calling
`createAgentCoreRuntime` with the *same* `agentName`. The server detects the existing
runtime and mints a **new version**. This has consequences that make the modify path
fundamentally different from create — read this before doing any modification.

## The full-config-not-patch rule (non-negotiable)

> An update replaces the agent's configuration **wholesale** with whatever you submit.
> There is no merge, no patch, no field-level update. Any field you omit is **gone** in
> the new version.

So the only safe way to modify an agent is:

1. **Fetch the complete current config** — `fetch_agent_config.py --agent XYZ` (the
   DEFAULT-qualifier config, plus the agent's `architectureType`).
2. **Mutate that object in memory** — change exactly the field(s) the user asked about,
   leave everything else byte-for-byte as it was.
3. **Re-submit the whole object** — `submit_runtime.py --agent XYZ --architecture <T>`.

Common edits:
- "remove skills" → delete the `skills` field (or set `[]`).
- "change the model" → set `modelInferenceParameters.modelId`.
- "add tool Z" → append `"Z"` to `tools`; if Z needs params, add `toolParameters["Z"]`.
- "raise the temperature" → set `modelInferenceParameters.parameters.temperature`.

If you ever find yourself building a config object with only the changed fields, **stop**
— that's a partial, and submitting it wipes the agent.

## Versioning & the DEFAULT qualifier

- The first submit creates version `1`. Each subsequent submit under the same name mints
  the next version (`2`, `3`, …). Visible via `numberOfVersion` /
  `listAgentVersions(agentRuntimeId)`.
- The Step Function advances the **DEFAULT** qualifier to the new version automatically —
  so after a successful update, `getDefaultRuntimeConfiguration` returns the new config.
- To point an *additional* endpoint qualifier at a version, use
  `submit_runtime.py --tag <qualifier>` (wraps `tagAgentCoreRuntime`). This is opt-in;
  you don't need it just to update DEFAULT.

## The tag-match guard (the surprising update failure)

When you update an existing runtime, the `create-runtime-version` Lambda checks that the
runtime's `Stack` and `Environment` tags match the stack the API belongs to
(`tags_match()`); on mismatch it raises `AcaException` and the Step Function lands in the
terminal `Create Failed` status.

**What this means:** you can only update agents **owned by the stack you're authenticated
against.** An agent created by a different stack/environment (e.g. a colleague's deploy,
or a different region) cannot be updated through this API — it fails during provisioning,
not at submit time.

`submit_runtime.py` knows whether the agent pre-existed (it was in `listRuntimeAgents`
before submit), so on a terminal failure of an *update* it surfaces the tag-match
explanation rather than a raw `AcaException`. RuntimeSummary carries no tags, so this
can't be pre-checked — it's detected as the most likely cause of an update that fails to
reach Ready.

## Polling is still mandatory

Update or create, the mutation is fire-and-forget: it returns `agentName` the instant the
Step Function starts. Confirmation is `submit_runtime.py` polling `RuntimeSummary.status`
(`Creating` → `Ready`, or terminal `Create Failed`). Don't tell the user the update
"worked" off the mutation return — wait for Ready.
