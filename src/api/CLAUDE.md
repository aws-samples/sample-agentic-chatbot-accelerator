# src/api — AppSync, Lambda, state machines

## AppSync is not in the chat path

Worth internalising before changing anything here: chat does **not** flow through AppSync or Lambda. The browser holds a direct SigV4-presigned WebSocket to the AgentCore runtime, and both chat tokens and tool-step updates stream over it.

What this tree actually does:

- **CRUD** — sessions, agents, evaluations.
- **Status notifications** — e.g. `notify-runtime-update` → `publishRuntimeUpdate` → GraphQL subscription → browser.

So a latency problem in chat is not an AppSync problem, and adding a resolver will not put you in the token path.

## The GraphQL codegen footgun

`make copy-graphql-util` copies `functions/outgoing-message-handler/graphql.ts` → `functions/notify-runtime-update/graphql.ts` before **every** deploy (it is a prerequisite of `deploy` and `tf-deploy`).

Edit the source. The copy is overwritten, and an edit there is silently lost at the next deploy.

## The evaluation-executor's `shared/` is generated

Same footgun, Python edition. `make copy-model-routing` copies four modules — `base_factory.py`, `mantle_support.py`, `stream_types.py`, `base_constants.py` — from `src/agent-core/shared/` into `functions/evaluation-executor/shared/`, plus an empty `__init__.py`, before **every** deploy (prerequisite of `deploy` and `tf-deploy`). The whole directory is gitignored.

`src/agent-core/shared/` is the only editable source. The copy is overwritten on every deploy, so an edit there is silently lost.

Two things it is easy to get wrong:

- The `__init__.py` is synthesized empty, never copied — the real one eagerly imports `bedrock-agentcore` and the MCP stack, neither of which is in the Lambda bundle.
- The copy has to happen before `cdk synth`, because the bundle's `artifactKey` embeds the asset hash computed at synth time. Copy afterwards and `build.sh` sees no diff, so the bundle ships without the module.

## State machines

`state-machines/` holds the runtime lifecycle: `create-agentcore-runtime.json`, `delete-agentcore-runtime.json`, `delete-agentcore-endpoints.json`.

Creation fans out to **two branches** — the `HTTP` runtime the UI talks to and its `A2A` twin — from one shared timestamp, so both runtimes agree on their version. See `src/agent-core/CLAUDE.md` for why the twin exists and for the runtime-name constraints (`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`, no hyphens, 48 chars including `_a2a`).

## Conventions

Python: PEP 8, type hints, Black + isort (88 cols), Ruff (E, F), AWS Lambda Powertools for logging and tracing, Google-style docstrings. Lambdas execute on AWS — there is no local runtime, so a change is verified by deploying.
