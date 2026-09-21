// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useStatusWatcher
//
// Owns the transport and the recovery policy behind every status watcher: an
// AppSync subscription, a re-read on reconnect, and a safety-net poll whose
// interval depends on the health of the real-time path. Feature wrappers supply
// the vocabulary; this module holds the policy.
//
import { CONNECTION_STATE_CHANGE, ConnectionState, generateClient } from "aws-amplify/api";
import { Hub } from "aws-amplify/utils";
import { useCallback, useEffect, useRef, useState } from "react";

/** First poll delay while the real-time path is unhealthy, doubling to POLL_MAX_MS. */
const POLL_INITIAL_MS = 5_000;
/** Ceiling for the unhealthy backoff. Not a give-up timeout — polling continues at this interval. */
const POLL_MAX_MS = 30_000;
/** Flat poll interval while the real-time path looks healthy: a publish can fail with no client-visible error. */
const POLL_HEALTHY_MS = 60_000;

interface ApiHubEventData {
    event: string;
    data?: { connectionState?: ConnectionState };
}

/** A generated subscription document, branded with the payload it delivers. */
export type SubscriptionDocument<TPayload> = string & {
    __generatedSubscriptionInput: Record<string, string>;
    __generatedSubscriptionOutput: TPayload;
};

export interface UseStatusWatcherOptions<TPayload = unknown> {
    /** Subscription filter value. Falsy disables the watcher entirely — no subscription, no Hub listener, no poll. */
    subscriptionKey?: string | null;
    /** Name of the subscription's single required filter variable. */
    keyVariableName: string;
    /** Generated subscription document from `graphql/subscriptions`. */
    document: SubscriptionDocument<TPayload>;
    /**
     * Whether a delivered payload concerns something the caller tracks.
     * Omit when the server-side filter already guarantees it. Read through a ref,
     * so a changing closure never resubscribes.
     */
    matches?: (payload: TPayload) => boolean;
    /**
     * Non-empty means "work is in flight" and enables the poll; empty idles it.
     * Must be a primitive so it can key an effect.
     */
    trackedKey: string;
    /** Re-read authoritative state. Called on delivery, on reconnect and on each poll tick. */
    onRefetch: () => void | Promise<void>;
}

/**
 * Watch a record set and trigger a re-read whenever its status may have changed.
 *
 * Never surfaces the payload — the store is the source of truth (ADR 0007). Polling is a
 * safety net that runs for as long as `trackedKey` is non-empty; the health of the
 * subscription chooses the interval, not whether to poll at all. Unsubscribes and clears
 * timers on unmount and whenever `subscriptionKey` changes.
 */
export function useStatusWatcher<TPayload = unknown>(
    options: UseStatusWatcherOptions<TPayload>,
): void {
    const { subscriptionKey, keyVariableName, document, matches, trackedKey, onRefetch } = options;

    const [realtimeUnhealthy, setRealtimeUnhealthy] = useState(false);
    const matchesRef = useRef(matches);
    const onRefetchRef = useRef(onRefetch);

    useEffect(() => {
        matchesRef.current = matches;
        onRefetchRef.current = onRefetch;
    }, [matches, onRefetch]);

    const refetch = useCallback(async () => {
        try {
            await onRefetchRef.current();
        } catch (error) {
            console.error("Status watcher refetch failed:", error);
        }
    }, []);

    useEffect(() => {
        if (!subscriptionKey) return;

        const client = generateClient();
        const subscription = client
            .graphql({ query: document, variables: { [keyVariableName]: subscriptionKey } })
            .subscribe({
                next: ({ data }) => {
                    // any delivery proves the channel is live: FR8
                    setRealtimeUnhealthy(false);

                    if (matchesRef.current && !matchesRef.current(data as TPayload)) return;
                    void refetch();
                },
                error: (error) => {
                    console.warn("Status subscription error:", error);
                    setRealtimeUnhealthy(true);
                },
            });

        return () => subscription.unsubscribe();
    }, [subscriptionKey, keyVariableName, document, refetch]);

    useEffect(() => {
        if (!subscriptionKey) return;

        let previousState: ConnectionState | undefined;
        return Hub.listen<ApiHubEventData>("api", ({ payload }) => {
            if (payload.event !== CONNECTION_STATE_CHANGE) return;

            const currentState = payload.data?.connectionState;
            if (!currentState) return;

            const someConnectionEstablished =
                previousState === ConnectionState.Connecting &&
                currentState === ConnectionState.Connected;
            previousState = currentState;

            // app-wide channel: a re-read is due (FR6), but only `next` clears health (FR8)
            if (someConnectionEstablished) void refetch();
        });
    }, [subscriptionKey, keyVariableName, document, refetch]);

    // polls on a healthy channel too: a swallowed publish failure produces no
    // notification and no subscription error, so health only picks the interval
    useEffect(() => {
        if (!subscriptionKey || trackedKey.length === 0) return;

        let delayMs = realtimeUnhealthy ? POLL_INITIAL_MS : POLL_HEALTHY_MS;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;

        const tick = async () => {
            if (stopped) return;
            await refetch();
            if (stopped) return;
            if (realtimeUnhealthy) delayMs = Math.min(delayMs * 2, POLL_MAX_MS);
            timer = setTimeout(() => void tick(), delayMs);
        };

        timer = setTimeout(() => void tick(), delayMs);

        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [subscriptionKey, realtimeUnhealthy, trackedKey, refetch]);
}
