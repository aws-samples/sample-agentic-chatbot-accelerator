# react-app — the web UI

React + Cloudscape, functional components, Prettier + ESLint.

## Dev loop, and the `aws-exports.json` trap

The app is configured at runtime by `public/aws-exports.json`, which a real deployment publishes from the `UserInterface` construct. To develop against a deployed backend:

1. Copy `<cloudfront-url>/aws-exports.json` into `public/aws-exports.json`.
2. `npm run dev`.

**`npm run build:dev` overwrites `public/aws-exports.json`** — re-populate it afterwards, or the next `npm run dev` will point nowhere. This catches everyone once.

The checked-in `public/aws-exports.json` is also why anything that searches the synth output for an emitted `aws-exports.json` asset has to exclude `public/` — the file names collide.

## The chat socket is direct

The browser connects **straight to the AgentCore runtime** over `wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN>/ws`, using a SigV4 presigned URL built from Cognito identity-pool credentials (`src/websocket-presigned.ts`). AppSync is not in that path: it serves CRUD and status subscriptions only.

Consequences when changing this area:

- Chat tokens *and* tool-step updates arrive on the same socket. A new stream of updates does not need a new transport.
- The presigned URL is a **bearer credential** with the power of the session. Never log it, never put it in a URL bar, never persist it.
- Voice is a mode of the same socket, entered by sending `voice_init` as the *first* message.

The Rust CLI in `cli/` speaks this same protocol, and its `src/protocol.rs` is written against this file. A wire-format change here has to be mirrored there.

## Config-driven navigation

Nav items and wizard steps appear based on what the deployment actually has: `aws-exports.json` carries the feature flags derived from the CDK config, so an omitted config block means a hidden nav item rather than a broken page. When adding a feature, gate the UI on the exports field rather than assuming the backend is present.
