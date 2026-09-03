# `aca` — terminal client for a deployed AgentCore agent

Chat with an agent deployed by this accelerator from a terminal, with no browser.

The deliverable of a deployment is the **agent**; the web UI is one way to reach
it. This CLI is another, and it needs nothing but a CloudFront URL and a Cognito
user — no AWS credentials, no `~/.aws`, no IAM role.

> The accelerator still deploys a CloudFront distribution today. Making the
> `UserInterface` construct optional is a separate piece of work, and the CLI
> currently *depends* on that distribution: the public `aws-exports.json` it
> serves is how the CLI bootstraps.

## Contents

1. [Prerequisites](#prerequisites)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [Configuration](#configuration)
5. [Running without `aws-exports.json`](#running-without-aws-exportsjson)
6. [Choosing an agent](#choosing-an-agent)
7. [In-chat commands](#in-chat-commands)
8. [Plain mode vs. the TUI](#plain-mode-vs-the-tui)
9. [Command reference](#command-reference)
10. [Troubleshooting](#troubleshooting)
11. [Limitations](#limitations)
12. [Security notes](#security-notes)

## Prerequisites

- **Rust 1.94.1 or newer.** This is the first Rust in the repo, which otherwise
  needs only Node, Python and `uv`. `cli/rust-toolchain.toml` pins 1.95.0, so
  `rustup` installs the right toolchain on first build with no action from you.

  The floor is not arbitrary and not ours: the AWS SDK crates (`aws-config`,
  `aws-sigv4`, `aws-sdk-cognito*`) all declare `rust-version = "1.94.1"`.

  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

- **A deployed accelerator backend** with at least one agent runtime, and a
  Cognito user in its user pool.

## Install

From this directory:

```bash
cargo build --release
```

The binary lands at `cli/target/release/aca`. To put it on your `PATH`:

```bash
cargo install --path .
```

From the repo root, `make cli-build`, `make cli-test` and `make cli-lint` wrap
the same commands.

## Quick start

Two inputs: the deployment's exports URL and your Cognito password.

```bash
aca --aws-exports-url https://d111111abcdef8.cloudfront.net/aws-exports.json chat
```

That fetches the deployment's public `aws-exports.json` (no credentials, no
signature — CloudFront serves it publicly), prompts for your email and password,
picks the agent if there is only one, and opens a chat window.

**Your first login will ask you to set a new password.** Every user in this
accelerator is admin-created, so accounts start in `FORCE_CHANGE_PASSWORD`.
Cognito allows roughly three minutes to answer that challenge — answer promptly
or you will have to rerun.

Every setting the exports file supplied is cached afterwards, so subsequent runs
need no flags at all:

```bash
aca chat
```

## Configuration

Three layers, highest precedence first. The first layer to supply a field wins.

1. **Flags and `ACA_*` environment variables** — an explicit override always
   wins, so a split or hand-rolled stack can be addressed field by field.
2. **The on-disk cache** — non-secret identifiers only.
3. **The deployment's public `aws-exports.json`** — fetched only when something
   is still missing, so a warm cache means no network call at all.

| Flag | Environment variable | Meaning |
|---|---|---|
| `--aws-exports-url` | `ACA_AWS_EXPORTS_URL` | URL of the deployment's public `aws-exports.json`. The primary bootstrap. |
| `--region` | `ACA_REGION` | AWS region hosting the deployment. |
| `--account-id` | `ACA_ACCOUNT_ID` | AWS account id. Needed for the runtime ARN the WebSocket presign signs over. |
| `--user-pool-id` | `ACA_USER_POOL_ID` | Cognito user pool id. |
| `--user-pool-client-id` | `ACA_USER_POOL_CLIENT_ID` | Cognito user pool **app client** id. |
| `--identity-pool-id` | `ACA_IDENTITY_POOL_ID` | Cognito identity pool id, exchanged for the SigV4 credentials. |
| `--appsync-url` | `ACA_APPSYNC_URL` | AppSync GraphQL endpoint. Used **only** to list agents. |
| `--no-cache` | — | Skip reading *and* writing the cache. |
| `--email` | `ACA_EMAIL` | Cognito user's email. Prompted when absent. |

### Config flags come *before* the subcommand

They are attached to the top-level command, not to `chat`, so this works:

```bash
aca --no-cache --region us-west-2 chat --runtime-id my_agent-AbCdEf1234 --qualifier DEFAULT
```

and this is a parse error:

```bash
aca chat --no-cache          # error: unexpected argument '--no-cache'
```

### The cache

`~/.config/aca-cli/config.json` (honours `XDG_CONFIG_HOME`), written `0600`
inside a `0700` directory. It holds the six identifiers above and **nothing
else** — no tokens, no credentials. That is structural rather than filtered: the
type that gets serialised has no secret field.

Delete the file, or pass `--no-cache`, to start over.

> **Known limitation: the cache is not keyed by source URL.** If you point
> `--aws-exports-url` at a *second* deployment while a complete cache exists, the
> cached deployment wins — because no field is left for the fetch to supply, so
> no fetch happens. Use `--no-cache` when switching deployments.

## Running without `aws-exports.json`

If the CloudFront distribution is unavailable, most of the configuration can be
derived by hand. **This is a manual recipe, not something the CLI implements** —
you still pass the results as flags.

Given only a Cognito ID token, decode its payload (it is base64url JSON):

| From | Gives |
|---|---|
| `iss` = `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>` | `--region` and `--user-pool-id` |
| `aud` | `--user-pool-client-id` |
| An identity pool id's own `<region>:<uuid>` form | confirms the region |
| `aws sts get-caller-identity` | `--account-id` — and this needs **no IAM permission**, so any credential works |

So the irreducible manual inputs are the **app client id**, the **identity pool
id**, and — only if you want `aca agents` — the **AppSync URL**. Everything else
either falls out of the token or is free to look up.

## Choosing an agent

List what is deployed:

```bash
aca agents
```

```
weather_agent
  runtime id:   weather_agent-AbCdEf1234
  architecture: SINGLE
  status:       Ready
  endpoint:     DEFAULT (version 3)
  endpoint:     staging (version 2)
```

`chat` picks the agent for you when there is no ambiguity:

- one agent with one endpoint → chosen silently, no prompt
- several agents, or several endpoints → you are shown a numbered menu; Enter
  takes the first entry

To skip discovery entirely — useful when AppSync is unreachable, or in a script:

```bash
aca chat --runtime-id weather_agent-AbCdEf1234 --qualifier DEFAULT
```

`--qualifier` is **required** in that path. There is no way to enumerate an
agent's endpoints without discovery, and guessing `DEFAULT` could connect you to
something you did not ask for.

The tradeoff for skipping discovery: the CLI cannot resolve the endpoint's
runtime *version*, so the session row the web UI's history list reads will show a
blank version for that conversation. Discovery fills it in.

## In-chat commands

A line starting with `/` is handled by the CLI instead of being sent to the agent.
They work in both the TUI and plain mode.

| Command | Does |
|---|---|
| `/session` (or `/new`) | Start a new session with the **same** agent |
| `/agent` (or `/agents`, `/switch`) | Switch to another agent, in a new session |
| `/help` (or `/?`) | List the commands |
| `/quit` (or `/exit`, `/q`) | Leave |

**Both commands start a genuinely new conversation.** An AgentCore session id maps
to its own microVM, so a new session is a new container with no memory of what came
before — that is the point of `/session` when an agent has wandered off, and it is
also why the first reply after one may be slow (a cold start).

**The TUI clears the transcript**, leaving one line to confirm what happened:

```
── new session on weather_agent-AbCdEf1234 / DEFAULT ──
```

The screen has to agree with the agent about what has been said, and a new
container has seen none of it. This is one-way: the TUI runs on the alternate
screen, so a cleared transcript is not in your terminal's scrollback either.
Copy anything you need out first.

Plain mode prints the same marker but keeps the text above it: a line already
written to a terminal cannot be taken back, and a redirected transcript has to
stay append-only.

`/agent` opens a picker listing every agent × endpoint pair, with its version,
architecture and status; `↑`/`↓` move, `Enter` switches, `Esc` cancels. It needs
an AppSync URL, the same as `aca agents` — with `--runtime-id` and no AppSync
endpoint configured there is nothing to list, and the command reports that.

Only a **leading** `/` counts, and only the first word: `does /etc/hosts exist?`
is a question, not a command. An unrecognised `/word` is reported rather than sent
on — an agent gamely answering a question about a command it has never heard of is
a worse outcome than being told the name was mistyped.

While a session is opening the prompt holds what you type rather than discarding
it — press Enter again once the status line clears.

## Plain mode vs. the TUI

On a terminal you get a full-screen view: a scrolling transcript, tokens
appearing as the agent produces them, a `using <tool>` indicator that resolves
when the tool finishes, and an input box that stays usable while a reply streams.
The title bar names the current agent and the session id — the one a CloudWatch
query needs.

| Key | Does |
|---|---|
| `Enter` | Send (or run an in-chat command) |
| `↑` / `↓`, `PageUp` / `PageDown` | Scroll the transcript |
| `Home` / `End`, `←` / `→` | Move within the input |
| `Ctrl-C` | Quit |
| `Ctrl-D` | Quit (on an empty line) |
| `Ctrl-U` | Clear the input |

In the `/agent` picker the keys change: `↑`/`↓` move, `Enter` switches, `Esc`
cancels, `Ctrl-C` still quits. The hint under the input box always says which set
is active.

Nothing blocks the terminal while a session opens. Opening one can take tens of
seconds (a cold container), so it runs in the background: scrolling and `Ctrl-C`
keep working throughout.

**Plain mode** is a linear, greppable transcript with no escape sequences. It is
selected automatically when stdout is not a terminal, so redirection just works:

```bash
aca chat -m "summarise the Q3 report" > answer.txt
```

`--plain` forces it on a terminal; `-m` / `--message` sends one prompt, prints
the reply, and exits. Plain mode also reads prompts from stdin, so a scripted
conversation is a here-doc:

```bash
aca chat --plain --email me@example.com --password-stdin <<'EOF'
password-goes-here
what is in the knowledge base about pricing?
and what about support tiers?
EOF
```

The in-chat commands work in plain mode too, so `/session` mid-script is a way to
ask a second question with no context from the first. `/agent` there uses the same
numbered stdin menu as startup rather than a picker, and needs an interactive
stdin — piped in, it has no way to answer its own prompt.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The **agent** reported an error |
| `2` | Configuration could not be resolved |
| `3` | Authentication failed |
| `4` | The WebSocket could not be established, or died mid-run |
| `5` | The invocation itself was wrong |

`1` is reserved for agent errors specifically so that infrastructure problems
never look like the agent misbehaving.

## Command reference

```
aca [CONFIG OPTIONS] [COMMAND]

Commands:
  chat      Interactive chat session (default — a bare `aca` runs it)
  agents    List deployed agents with their endpoints, and exit
```

`chat` options, in addition to the config flags above:

| Flag | Meaning |
|---|---|
| `--email <EMAIL>` | Cognito email. Prompted when absent. |
| `--password-stdin` | Read the password from stdin rather than prompting. There is deliberately **no** `--password`: an argument would sit in your shell history and in every process listing. |
| `--runtime-id <ID>` | Target runtime. Skips discovery. |
| `--qualifier <NAME>` | Endpoint qualifier, e.g. `DEFAULT`. Required with `--runtime-id`. |
| `--session-id <ID>` | Resume an existing session. Must be at least 33 characters. |
| `--plain` | Force line mode. |
| `-m`, `--message <TEXT>` | Send one prompt and exit. Implies `--plain`. |

`agents` takes `--email` and `--password-stdin` only.

## Troubleshooting

The log file is at `~/.cache/aca-cli/aca.log` (honours `XDG_CACHE_HOME`), written
`0600`. **Nothing is ever logged to stdout or stderr by the logger** — stdout is
the transcript. Raise the level with `ACA_CLI_LOG`:

```bash
ACA_CLI_LOG=debug aca chat
tail -f ~/.cache/aca-cli/aca.log
```

Presigned URLs in the log are redacted by an allowlist, so a log file is safe to
attach to a bug report. Check it anyway before you do.

| Message | What it means, and what to do |
|---|---|
| `incorrect email or password` | Cognito rejected the login. Note this is also what an *expired password-change challenge* looks like — if you were part-way through setting a new password, rerun. |
| `this CLI cannot answer the ... challenge; sign in via the web UI once to clear it` | MFA or a challenge type this client does not implement. Sign in through the web UI once. |
| `the password-change challenge expired (Cognito allows ~3 minutes)` | You took too long on the new-password prompt. Rerun. |
| `the ID token contains no usable sub` | The token carries no identity. Refusing to continue is deliberate: the container would silently store history nobody can read back. |
| `identity pool refused the token` | The user pool is not wired to the identity pool, or the token is stale. |
| `access denied (403) — the signature or the identity-pool permissions are wrong` | Either the presign is wrong or the authenticated role lacks `bedrock-agentcore:InvokeAgentRuntime` on that runtime. The 403 body is quoted in the message; the log has more. |
| `no such runtime or endpoint (404)` | Wrong `--runtime-id` or `--qualifier`. Run `aca agents` to see the real names. |
| `the previous session is still shutting down (409) — retrying` | Informational. Retried automatically with backoff, up to five attempts. |
| `still conflicting after 5 attempts` | The previous session has not released. Wait, or use a different `--session-id`. |
| `the agent container itself returned an error (424) — check its CloudWatch logs` | Your agent code failed, not the transport. The container's CloudWatch log group is where the real error is. |
| `throttled (429) — retry shortly` | Service-side throttling. |
| `session id must be at least 33 characters` | `--session-id` too short. AgentCore rejects shorter ids with an opaque 400, so this is caught locally instead. |
| `closed by the service (code ...) — WebSocket sessions are capped at 60 minutes` | The hard session cap. Start a new run; pass the same `--session-id` to keep the conversation if the runtime has Memory attached. |
| `connection timed out after 60s; the runtime may be cold-starting` | First invocation of an idle runtime. Retry. |
| `no AppSync endpoint is configured` | Discovery needs `--appsync-url` (usually supplied by the exports file). Or bypass it with `--runtime-id` and `--qualifier`. |
| `AppSync returned errors: Not Authorized...` | Your user can authenticate but cannot read `listRuntimeAgents`. Use `--runtime-id` and `--qualifier`. |
| `no agents are deployed in this account` | Nothing to talk to. Create an agent via the Agent Factory UI or `agentRuntimeConfig`. |
| `agent X has no endpoints` | The runtime exists but has no endpoint. Deploy one. |
| `incomplete configuration: missing ...` | Every missing field is listed with the flag that supplies it. `--aws-exports-url` supplies them all at once. |

## Limitations

- **Voice is out of scope.** The container's Nova Sonic bidirectional mode is
  reachable over the same socket, but this client is text only. Voice frames are
  received and ignored.
- **No agent creation or editing.** Use the Agent Factory UI, or the
  `agent-creator` Claude Code plugin.
- **Conversation history does not survive process exit** unless the target
  runtime has **AgentCore Memory** attached. The session row still appears in the
  web UI's history list either way, which makes the difference easy to miss. The
  CLI cannot warn you about this: the memory setting is not exposed by the query
  it uses to list agents.
- **Verified against the single-agent container only** (`src/agent-core/docker/`).
  The swarm, graph and agents-as-tools containers emit a partly different event
  set; unrecognised events are ignored rather than displayed, so those
  architectures should work but may show less.
- **Credentials are never persisted**, so every run asks for a password. This is
  deliberate, not an oversight — see below.
- **`/session` and `/agent` cannot be undone.** The socket is closed, the
  container released, and in the TUI the transcript is cleared — which the
  alternate screen makes unrecoverable. There is no scrollback to go back to.
- **One session at a time.** No split view, no tabs; a second `/session` while the
  first is still opening is refused rather than queued.
- **The TUI has one view.** No history search, no message editing, no session
  browser.

## Security notes

- **Nothing secret reaches disk.** The only file written is the config cache, and
  the type serialised into it has no secret field. Both the cache and the log are
  `0600` in `0700` directories.
- **The presigned WebSocket URL is a bearer credential** with the same power as
  the session itself. It is never printed, never passed as an argument, and
  redacted in the log. It expires after 300 seconds — the documented maximum.
- **No credential caching, by design.** Persisting the refresh token would make
  the CLI a standing credential on disk; re-authenticating each run is the
  tradeoff taken instead.
- **`USER_PASSWORD_AUTH` sends the password to Cognito inside TLS.** SRP
  (`USER_SRP_AUTH`), which never transmits the password, was considered and
  rejected: the AWS SDK for Rust implements no SRP, and the only purpose-built
  crate is single-maintainer — and `make run-ash` has no Rust SCA coverage to vet
  it with. Taking an unvetted dependency into the authentication path is the
  worse trade. Revisit if a maintained crate or SDK support appears.
- **The password is read with echo disabled** and held in a type that prints
  `[redacted]` and zeroes itself on drop. There is no `--password` flag.
- This CLI inherits the accelerator's posture: it is a **proof of value, not
  production-ready**. Apply the AWS Shared Responsibility Model before putting it
  in front of users.

## Development

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

All three are required. `clippy` runs with `-D warnings`, so a warning is a
build failure.

`cli/` is a library plus a thin `aca` binary. The library exists so integration
tests in `cli/tests/` can load golden fixtures, and so modules are public API
rather than dead code.

Two structural rules worth knowing before you change dependencies:

- **Exactly one rustls crypto provider.** `rustls` is pinned to 0.23 with
  `aws_lc_rs`, and the AWS SDK crates carry `default-features = false` so their
  default `rustls` feature does not pull in the legacy rustls 0.21 + `ring`
  stack. A second provider in the graph is an **opaque panic at the first TLS
  connection**, not a compile error. Run `cargo tree -i rustls` after touching
  dependencies.
- **`ratatui` uses one unstable feature**, `unstable-rendered-line-info`, for
  `Paragraph::line_count`. The transcript's scroll offset is derived from the
  post-wrap row count; reimplementing ratatui's wrap algorithm would disagree
  with what is on screen for wide characters.

> Some code comments reference ADR-0007, ADR-0008 and ADR-0009 for the SRP,
> `aws-exports.json`-as-contract and TLS-provider decisions. **Those ADRs have
> not been written yet** — the reasoning currently lives in this README and in
> the design doc.
