# 0007 — Real-time notifications are hints, not state

- Status: Accepted
- Date: 2026-09-18
- Context: [resiliant-subscription story](../../local/user-stories/resiliant-subscription/story.md), [design doc](../../local/user-stories/resiliant-subscription/design-doc.md)

## Context

`receiveEvaluationUpdate` and `publishEvaluationUpdate` shipped in `schema.graphql` with neither a publisher nor a resolver, so every evaluation surface derived run status from its own component state — the manager on a flat 2s `setInterval`, the results page and the history modal not at all. The one subscription precedent in the app (`publishRuntimeUpdate` / `receiveUpdateNotification`, `agent-core-runtime-manager.tsx:401-417`) unsubscribes on error and after the first delivery, so once the channel drops the surface has no path to convergence left.

Amplify makes that unreliability part of the contract: subscriptions *"will automatically reconnect when it becomes possible to do so"*, but *"While offline, your application will miss messages and will not automatically catch up when reconnected."* ([subscribe-data docs](https://docs.amplify.aws/react/build-a-backend/data/subscribe-data/), verified 2026-09-18 against `aws-amplify ^6.20.0`). Reconnect is therefore free; catch-up is the client's problem.

## Decision

A notification carries identifiers and a status only, and is **never rendered**: it names a record worth re-reading. Each surface re-reads the authoritative store on notification, on mount, and on Amplify's `Connecting → Connected` transition. Polling runs for as long as a surface tracks in-flight work, because a publish failure is swallowed and so produces neither a notification nor a subscription error; the health of the real-time path chooses only the interval (60s while healthy, 5s doubling to a 30s cap while not, no give-up ceiling). It is a safety net, not the primary mechanism. In-flight work is derived from that same re-read — no client-side persistence.

`use-evaluation-run-watcher.ts` is the reference implementation: it returns `void`, reads `runId` from the payload to filter, and ignores `status` entirely.

## Consequences

- **Positive:** the notification payload stays free to evolve — adding a field never becomes a client-render contract, and the subscription stayed `evaluatorId`-filtered with no schema change.
- **Positive:** one recovery policy serves all three surfaces; convergence depends on the re-read, not on delivery.
- **Negative:** an extra round trip per notification, N concurrent re-reads when one notification reaches N mounted surfaces, and a read per healthy-path interval per tracked item even when every notification arrives.
- **Negative:** **a degraded read is indistinguishable from emptiness.** All three resolvers behind these surfaces swallow a DynamoDB `ClientError` into a successful-looking empty answer (`evaluation-resolver/index.py:130-132`, `:165-167`, `:546-548`). Because the notification carries no state, that re-read is the client's only source of truth, so a throttled read looks exactly like "the run you were tracking is gone". Each consuming surface needs its own guard against retiring in-flight state — or the rows that carry it — on an empty response, while still letting a genuinely empty store render as empty.
- **Negative:** **re-reads need ordering.** Every trigger issues the same read, so concurrent reads race and a stale in-progress response resolving after a fresh terminal one silently reverts the surface — with no further trigger on a healthy channel. Each surface carries a monotonic generation counter and drops responses from an older generation.
- **Negative:** **Hub connection state is app-wide, not per-subscription.** Amplify records `OPENING_CONNECTION` on every `subscribe` even when the socket is already open, so `Connecting → Connected` fires for any component subscribing anywhere in the app. It is usable as "a re-read is due", but **not** as evidence that a given subscription recovered — treating it as recovery drops the poll to its slow healthy-path interval while that subscription is still dead.
- **Trade-off:** if no terminal notification is ever published (the executor dies, the message is DLQ'd), nothing converges: the surface polls the truthful non-terminal record indefinitely. Accepted over a client-side timeout, which would render a terminal status the store does not hold.
- **Trade-off:** agent lifecycle, KB sync and experiments keep the older shape (first-delivery-and-error unsubscribe, manual refresh, no catch-up) until they migrate, so the app has two idioms. Accepted to keep this change reviewable; those migrations inherit the three hazards above.
