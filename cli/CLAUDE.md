# cli — `aca`, the terminal chat client

The only Rust in the repo (edition 2024). Gate before a PR: `make cli-lint` from the repo root — clippy runs `-D warnings`, so a warning is a failure.

## The constraint that shapes everything

**`aca` must not require AWS credentials.** A user gets a Cognito username and password, nothing more. That single rule is why:

- Backend identity comes from the deployment's *public* `aws-exports.json`, fetched unauthenticated, or from `ACA_*` env vars / flags. No `describe-stacks`, no SSM, no STS.
- Identity-pool credentials are obtained from the Cognito login and used only to sign the WebSocket presign.

Anything that reaches for the AWS control plane to discover configuration is the wrong answer here, however convenient. The stack outputs are read *once, by the operator who deployed*; the user consumes what the operator hands them.

## Module bands

`protocol` and `presign` are **pure** and carry the whole opaque-failure surface — a bad presign comes back as a bare 403, so the logic that builds one has to be testable without a network. Keep them that way.

`src/protocol.rs` is written against the browser's `src/user-interface/react-app/src/websocket-presigned.ts`. The two must agree on the wire format.

## Gotchas that cost real time

- **Session ids must be ≥ 33 characters** (`MIN_SESSION_ID_LEN`, max 256 per the `InvokeAgentRuntime` API reference). A shorter one is rejected by AgentCore with an error that does not say so.
- **Presign expiry maxes at 300 s** (`presign::EXPIRES_IN_SECS`); `presign_ws_url` rejects anything larger rather than letting the service refuse it later.
- **An empty `userId` silently drops history** — the turn succeeds and the session simply isn't persisted.
- **rustls needs its crypto provider installed before any TLS use.** Two crates in the graph depend on rustls without selecting a provider, so the failure mode is an opaque panic at first connect, not a compile error. `main.rs` installs it first, before anything else.
- **No presigned URL is ever accepted as an argument**, and there is no `--password`: an argument persists in shell history and in every process listing.

## Config file

`~/.config/aca-cli/config.json` (honours `XDG_CONFIG_HOME`) — pretty-printed JSON, `0600` inside a `0700` directory, holding exactly the six non-secret identifiers. It holds **no secret by construction**: `AppConfig` has no secret field, which is what makes persisting it safe. The permissions are the backstop for future code, not for today's.

Resolution precedence is flags/env > config file > fetched exports, merged by one `Partial::fill_from` operation rather than per-field `or_else` chains — precedence bugs hide in the latter.

Two tolerances are deliberate: a corrupt or half-written config file reads as absent rather than fatal (which is also what makes the non-atomic write safe), and a failed config write is logged, never fatal. Keep both.

`--no-cache` means "don't read or write the config file"; `--fresh-login` means "don't reuse the saved session" but *does* save the new one. Two files, two risk profiles, deliberately two flags.

## Non-interactive behaviour is a contract

A run with no TTY must fail with the list of every missing field and the flag that supplies it — never block on a prompt. CI and `--message` one-shots depend on this, and it is the sharpest regression risk in this crate.
