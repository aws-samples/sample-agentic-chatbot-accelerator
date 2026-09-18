// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useEvaluationRunWatcher
//
// Owns the transport and the recovery policy for evaluation run-status
// changes: an AppSync subscription, a re-read on reconnect, and bounded
// backoff polling when the real-time path is unhealthy.
//
import { CONNECTION_STATE_CHANGE, ConnectionState, generateClient } from "aws-amplify/api";
import { Hub } from "aws-amplify/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { receiveEvaluationUpdate } from "../../graphql/subscriptions";

/** First fallback poll delay, doubling to POLL_MAX_MS. */
const POLL_INITIAL_MS = 5_000;
/** Ceiling for the fallback poll backoff. Not a give-up timeout — polling continues at this interval. */
const POLL_MAX_MS = 30_000;

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
 * DynamoDB is the source of truth (ADR 0007). Polling is a fallback, entered when the
 * subscription reports an error and left when a notification is delivered on it.
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

    useEffect(() => {
        if (!evaluatorId || !realtimeUnhealthy || runIdsKey.length === 0) return;

        let delayMs = POLL_INITIAL_MS;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;

        const tick = async () => {
            if (stopped) return;
            await refetch();
            if (stopped) return;
            delayMs = Math.min(delayMs * 2, POLL_MAX_MS);
            timer = setTimeout(() => void tick(), delayMs);
        };

        timer = setTimeout(() => void tick(), delayMs);

        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [evaluatorId, realtimeUnhealthy, runIdsKey, refetch]);
}
