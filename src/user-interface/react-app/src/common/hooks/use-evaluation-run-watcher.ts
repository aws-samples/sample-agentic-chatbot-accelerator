// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useEvaluationRunWatcher
//
// Owns the transport and the recovery policy for evaluation run-status
// changes: an AppSync subscription, a re-read on reconnect, and a safety-net
// poll whose interval depends on the health of the real-time path.
//
import { CONNECTION_STATE_CHANGE, ConnectionState, generateClient } from "aws-amplify/api";
import { Hub } from "aws-amplify/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { receiveEvaluationUpdate } from "../../graphql/subscriptions";

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

export interface UseEvaluationRunWatcherOptions {
    /** Evaluator to subscribe to. Falsy disables the watcher entirely (no subscription, no polling). */
    evaluatorId?: string | null;
    /** Run ids the caller cares about. A notification for any other run is discarded. Empty means "no run in flight" — the watcher idles. */
    runIds: string[];
    /** Re-read authoritative state. Called on notification, on reconnect, and on each poll tick; must be stable (useCallback). */
    onRefetch: () => void | Promise<void>;
}

/**
 * Watch evaluation runs and trigger a re-read whenever their status may have changed.
 *
 * The notification is a hint only — this hook never surfaces the payload, because
 * DynamoDB is the source of truth (ADR 0007). Polling is a safety net that runs for as
 * long as `runIds` is non-empty; the health of the subscription chooses the interval,
 * not whether to poll at all.
 * Unsubscribes and clears timers on unmount and whenever `evaluatorId` changes.
 */
export function useEvaluationRunWatcher(options: UseEvaluationRunWatcherOptions): void {
    const { evaluatorId, runIds, onRefetch } = options;
    const runIdsKey = [...runIds].sort().join(",");

    const [realtimeUnhealthy, setRealtimeUnhealthy] = useState(false);
    const trackedRunIds = useRef<Set<string>>(new Set());
    const onRefetchRef = useRef(onRefetch);

    useEffect(() => {
        trackedRunIds.current = new Set(runIds);
        onRefetchRef.current = onRefetch;
    }, [runIds, onRefetch]);

    const refetch = useCallback(async () => {
        try {
            await onRefetchRef.current();
        } catch (error) {
            console.error("Evaluation run refetch failed:", error);
        }
    }, []);

    useEffect(() => {
        if (!evaluatorId) return;

        const client = generateClient();
        const subscription = client
            .graphql({ query: receiveEvaluationUpdate, variables: { evaluatorId } })
            .subscribe({
                next: ({ data }) => {
                    // any delivery proves the channel is live: FR8
                    setRealtimeUnhealthy(false);

                    const runId = data?.receiveEvaluationUpdate?.runId;
                    if (!runId || !trackedRunIds.current.has(runId)) return;
                    void refetch();
                },
                error: (error) => {
                    console.warn("Evaluation update subscription error:", error);
                    setRealtimeUnhealthy(true);
                },
            });

        return () => subscription.unsubscribe();
    }, [evaluatorId, refetch]);

    useEffect(() => {
        if (!evaluatorId) return;

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
    }, [evaluatorId, refetch]);

    // polls on a healthy channel too: a swallowed publish failure (FR3) produces no
    // notification and no subscription error, so health only picks the interval
    useEffect(() => {
        if (!evaluatorId || runIdsKey.length === 0) return;

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
    }, [evaluatorId, realtimeUnhealthy, runIdsKey, refetch]);
}
