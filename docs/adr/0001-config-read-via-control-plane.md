# 0001 — Read agent config from bundles via the control plane, not Gateway/baggage

- Status: Accepted
- Date: 2026-07-20
- Context: [configuration-bundles story](../../local/user-stories/configuration-bundles/story.md), [design doc](../../local/user-stories/configuration-bundles/design-doc.md)

## Context

We are migrating per-agent runtime configuration from `agentCoreRuntimeTable` (DynamoDB) to AgentCore configuration bundles. AWS documents two ways for a container to read a bundle at runtime:

1. **SDK / baggage** — `BedrockAgentCoreContext.get_config_bundle()` reads the active bundle reference from a W3C **baggage** header (`aws.agentcore.configbundle_arn` / `_version`). In production this header is injected by the **AgentCore Gateway** during A/B tests. Without a bundle reference in the request context, the call returns `{}`.
2. **Control plane** — `bedrock-agentcore-control get_configuration_bundle_version(bundleId, versionId)` returns `components[<key>].configuration` directly, with no baggage and no Gateway involved.

This accelerator's chat data plane is **browser-direct WebSocket** to `wss://…/runtimes/<ARN>/ws`. There is **no AgentCore Gateway** in the path, and we do not use A/B testing. The SDK/baggage path would therefore observe no bundle reference and return `{}`.

## Decision

Containers read configuration via the **control plane**: `get_configuration_bundle_version(BUNDLE_ID, BUNDLE_VERSION)`, with `BUNDLE_ID` and `BUNDLE_VERSION` supplied as container environment variables (mirroring today's `agentName`/`createdAt` pointer-env pattern). The fetch is wrapped in try/except with a fallback to embedded defaults, per AWS's runtime guidance.

## Consequences

- **Positive:** Works without a Gateway; minimal change to the existing pointer-env + startup-fetch shape; the parsed `AgentConfiguration` is unchanged.
- **Positive:** We control the component key (see [ADR-0002](0002-bundle-identity-and-component-keying.md)) since we address the bundle explicitly rather than via injected baggage.
- **Negative / deferred:** Gateway-driven A/B testing and the Recommendations flow (which rely on baggage injection) are out of scope; adopting them later would add the Gateway to the data plane — a separate, larger decision.
- **Cost:** One control-plane API call at container cold start, plus least-privilege `bedrock-agentcore-control:GetConfigurationBundleVersion` on the container task role.
