# src/agent-core — agent containers

Everything here runs **inside an AgentCore Runtime container on AWS**. There is no local runtime: the Python environment at the repo root exists for the IDE and the linters only, so a change is verified by deploying, not by running.

## The runtime contract

Non-negotiable, and every image must hold it:

- ARM64, FastAPI bound to `0.0.0.0:8080`.
- `/ws` — the chat socket. The browser connects to it **directly** via a SigV4 presigned URL; neither AppSync nor Lambda is in the chat path. Chat tokens *and* tool-step updates stream over this one socket.
- `/invocations` — HTTP + SSE, for non-browser callers.
- `/ping` — health.
- Stateless. Session history is loaded and written per turn; nothing survives in process memory that matters.

Voice is a mode of `/ws`, not a second endpoint: when the *first* message is `voice_init` the connection flips into a Nova Sonic `BidiAgent`.

## One pattern, one image

`docker/` (single agent), `docker-agents-as-tools/` (orchestrator + sub-agents), `docker-swarm/`, `docker-graph/` (directed graph). They are separate images on purpose — an orchestrator's dependency set and startup cost have no business in a single agent.

Anything shared lives in `shared/`: the BidiAgent adapter, session history, the MCP client, the model factory, A2A. A fix that belongs to more than one pattern belongs there, not copied.

Dockerfiles ship precompiled bytecode (`UV_COMPILE_BYTECODE`) — roughly 47% faster cold start for about +90 MB. Don't "shrink the image" by dropping the `.pyc` files; the trade was made deliberately.

## Config comes from AgentCore configuration bundles

**Not DynamoDB.** A container reads its config with `get_configuration_bundle_version(BUNDLE_ID, BUNDLE_VERSION)` through the **control plane**, with those two values injected as env vars. There is no Gateway and no baggage in this data plane.

A failed or empty fetch **raises, and the container refuses to start**. That is deliberate fail-fast: there is no fallback to embedded defaults, because a container that boots with the wrong config is worse than one that doesn't boot. Read ADR-0001 and ADR-0002 before changing any of this.

## Sub-agents are reached over A2A, and every agent is two runtimes

Every SINGLE-image agent is created as **two** AgentCore runtimes: an `HTTP` one the UI talks to, and an `A2A` twin named `<agentName>_a2a`. Orchestrators reach sub-agents through the twin (`A2AClientToolProvider`, SigV4-signed against `bedrock-agentcore`); the UI never touches it.

Runtime names must match `^[a-zA-Z][a-zA-Z0-9_]{0,47}$` — **no hyphens**, and 48 characters *including* the `_a2a` suffix, so the base name has 44 to work with.

Isolation is microVM-per-session, and sub-agents are stateless workers. Both are settled decisions.

## Models: provider dispatch

`create_model` in `shared/base_factory.py` dispatches four ways by provider, Bedrock Mantle among them for the OSS model tail. The UI-facing catalog is region-scoped (ADR-0003, ADR-0004).

Reasoning and effort parameters differ per model family, and **AWS documentation has repeatedly been wrong about them** — live probes have overturned model cards more often than they've confirmed them. Validate against a real invocation before trusting a doc page, and when a probe contradicts the documentation, record the finding next to the capability entry rather than deleting the entry.

## Conventions

PEP 8, type hints, Black + isort (88 cols), Ruff (E, F; E501 ignored), AWS Lambda Powertools for logging and tracing. Google-style docstrings (`Args:` / `Returns:` / `Raises:`, `name (type): description`) — `shared/` is the reference for tone and density.

The comments in this tree carry protocol quirks, AWS bugs, and deliberate trade-offs that cost real time to discover. Read them before simplifying something that looks redundant, and preserve them through a refactor.
