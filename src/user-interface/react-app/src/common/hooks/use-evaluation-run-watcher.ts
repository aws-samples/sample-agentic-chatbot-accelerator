// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useEvaluationRunWatcher
//
// Feature adapter over `useStatusWatcher`: supplies the evaluation vocabulary
// (subscription, filter variable, run-id match) and nothing else. The transport
// and the recovery policy live in the core.
//
import { receiveEvaluationUpdate } from "../../graphql/subscriptions";
import { useStatusWatcher } from "./use-status-watcher";

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
 * Feature adapter over `useStatusWatcher`: binds `receiveEvaluationUpdate`, keys on
 * `evaluatorId` and filters deliveries by `runId`. The recovery policy lives in the core.
 */
export function useEvaluationRunWatcher(options: UseEvaluationRunWatcherOptions): void {
    const { evaluatorId, runIds, onRefetch } = options;

    useStatusWatcher({
        subscriptionKey: evaluatorId,
        keyVariableName: "evaluatorId",
        document: receiveEvaluationUpdate,
        // a fresh array every render at two call sites: the sorted key keeps the effect stable
        trackedKey: [...runIds].sort().join(","),
        matches: (payload) => {
            const runId = payload?.receiveEvaluationUpdate?.runId;
            return !!runId && runIds.includes(runId);
        },
        onRefetch,
    });
}
