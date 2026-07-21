# 0002 — Bundle identity and single stable-id component keying

- Status: Accepted
- Date: 2026-07-20
- Context: [configuration-bundles story](../../local/user-stories/configuration-bundles/story.md), [design doc](../../local/user-stories/configuration-bundles/design-doc.md)
- Supersedes: story §7 (which proposed ARN-keyed components)

## Context

A configuration bundle holds `components` keyed by an identifier, each with a `configuration` object. The AWS examples key components by the **runtime ARN**. Two facts make an ARN key awkward here:

1. **Circular dependency.** With direct control-plane reads ([ADR-0001](0001-config-read-via-control-plane.md)), the container needs `BUNDLE_ID`/`BUNDLE_VERSION` as env vars at runtime-create time. If the component were keyed by the runtime ARN, the ARN would not exist until the runtime is created — forcing a create-runtime → create-bundle → update-runtime-env sequence with extra control-plane calls and more failure states in the state machine.
2. **Naming.** Bundle **names** forbid hyphens (`[a-zA-Z][a-zA-Z0-9_]{0,99}`), but agent names may contain them, so the name alone can't be the durable identifier.

## Decision

1. **One bundle per agent, one component keyed by a stable agent id** (the `agentCoreSummaryTable` partition key). Both the HTTP runtime and the A2A twin read that same component (identical config). The bundle is created **before** the runtime, so `BUNDLE_ID`/`BUNDLE_VERSION` flow cleanly into the runtime's container env — no create→update dance.
2. **Bundle identity of record lives in `agentCoreSummaryTable`.** On create, derive a sanitized bundle-name *prefix* from the agent name, let AWS append its random suffix, and persist the returned `bundleId` and `bundleArn`. All later reads/updates/ports use the stored `bundleId` — we never reverse-map an agent name to a bundle.
3. **Versions** map 1:1: each config change is a new immutable bundle version (chained via `parentVersionIds`); `QualifierToVersion` stores the active `versionId`.

## Consequences

- **Positive:** No circular dependency; the write path is a straight line (put-bundle → create-runtime → update-summary). Sub-agents keep their own bundles and are resolved via the summary table as today.
- **Positive:** Robust to hyphenated agent names and name collisions (AWS suffix + stored id).
- **Negative:** Diverges from the ARN-keyed AWS examples; anyone inspecting bundles directly must know the component key is the agent id, not the ARN. Documented in the design doc's cross-cutting contract.
- **Trade-off:** A single shared component means HTTP and A2A twins cannot diverge in config; acceptable because they are twins of the same agent by design.
