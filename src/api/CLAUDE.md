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

## State machines

`state-machines/` holds the runtime lifecycle: `create-agentcore-runtime.json`, `delete-agentcore-runtime.json`, `delete-agentcore-endpoints.json`.

Creation fans out to **two branches** — the `HTTP` runtime the UI talks to and its `A2A` twin — from one shared timestamp, so both runtimes agree on their version. See `src/agent-core/CLAUDE.md` for why the twin exists and for the runtime-name constraints (`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`, no hyphens, 48 chars including `_a2a`).

## Conventions

Python: PEP 8, type hints, Black + isort (88 cols), Ruff (E, F), AWS Lambda Powertools for logging and tracing, Google-style docstrings. Lambdas execute on AWS — there is no local runtime, so a change is verified by deploying.
