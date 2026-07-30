# 0005 — "Update container" adopts the current image, it does not rebuild from source

- Status: Accepted
- Date: 2026-07-30
- Context: [refactor-runtime-manager-ui story](../../local/user-stories/refactor-runtime-manager-ui/story.md), [design doc](../../local/user-stories/refactor-runtime-manager-ui/design-doc.md)

## Context

The AgentCore Runtime Manager gains an "Update container" action. The intuitive expectation is "rebuild the agent's Docker image so my source-code changes take effect." Investigation of the build pipeline shows this is not achievable from the running application:

1. **The container images are generic.** Agent behavior comes from the config bundle read at runtime, not from the image. There is one pre-built image per architecture (single / swarm / graph / agents-as-tools); a "new version" only re-versions *config* against the same image.
2. **Image tags are content-hash-pinned at deploy time.** `codebuild-docker-image.ts:83-93` derives the tag from an S3 asset of the build-context directory. The S3 source asset and `IMAGE_TAG` are refreshed only at `cdk synth`/deploy.
3. **Builds are triggered only by the deploy-time script.** `iac-cdk/scripts/build.sh:226` is the sole caller of `codebuild start-build`; there is no Lambda, mutation, Step Function, or EventBridge rule that starts a build or reacts to build completion.
4. **A Lambda `start-build` would rebuild stale source.** Triggering an existing builder project re-produces the *last-deployed* source snapshot, not newer local code — so even a new backend path could not pick up source changes without refreshing the build asset (a deploy operation).
5. **The runtime Lambda's `CONTAINER_URI` env is refreshed every deploy** (`agent-core-runtime.ts:79-82,647-650`), but existing runtimes stay pinned to the image tag they were created with — they do not auto-adopt a newer image.

## Decision

"Update container" **re-versions the selected runtime against the image URI currently baked into the runtime Lambda's environment**, keeping the same config bundle. Concretely it reuses the already-deployed path: fetch the agent's current configuration (`getDefaultRuntimeConfiguration`) and re-submit it via `createAgentCoreRuntime`, which calls `update_agent_runtime` with the current env `containerUri` and mints a new runtime version (`create-runtime-version/index.py:241-245,289,332-347`).

This is implemented **entirely client-side** by reusing two deployed GraphQL operations — no new mutation, Lambda, IAM, CodeBuild trigger, or ECR polling.

## Consequences

- **Positive:** Small, safe, UI-only change; lets an existing runtime adopt a platform image update that a prior `make deploy` published, without recreating the agent or editing its config.
- **Positive:** No new IAM surface, no coupling to the deploy pipeline, no long-running build/poll state to manage in the app.
- **Negative / expectation gap:** The action does **not** pick up an author's new source code. Picking up new source still requires `make deploy` (which refreshes the build asset and rewires `CONTAINER_URI`). The UI copy and task docs must state this clearly so the action isn't mistaken for a source rebuild.
- **Trade-off:** A true button-triggered source rebuild is deferred indefinitely; it would require refreshing the S3 build-context asset from outside a deploy plus a build-completion→URI adoption mechanism — a cross-stack effort out of proportion to the value here.
