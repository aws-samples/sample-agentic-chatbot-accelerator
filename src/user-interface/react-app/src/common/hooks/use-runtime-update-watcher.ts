// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Hook: useRuntimeUpdateWatcher
//
// Feature adapter binding `receiveUpdateNotification` to the shared status
// watcher core. Transport and recovery policy live in useStatusWatcher.
//
import { receiveUpdateNotification } from "../../graphql/subscriptions";
import { useStatusWatcher } from "./use-status-watcher";

export interface UseRuntimeUpdateWatcherOptions {
    /** Agent to subscribe to. Falsy disables the watcher entirely (no subscription, no polling). */
    agentName?: string | null;
    /** Re-read authoritative state. Called on notification, on reconnect, and on each poll tick; must be stable (useCallback). */
    onRefetch: () => void | Promise<void>;
}

/**
 * Watch one agent runtime and trigger a re-read whenever its status may have changed.
 *
 * Feature adapter over `useStatusWatcher`: binds `receiveUpdateNotification` and keys on
 * `agentName`. No payload filter — the subscription is already single-agent server-side and
 * the payload carries nothing but the name.
 */
export function useRuntimeUpdateWatcher(options: UseRuntimeUpdateWatcherOptions): void {
    const { agentName, onRefetch } = options;

    useStatusWatcher({
        subscriptionKey: agentName,
        keyVariableName: "agentName",
        document: receiveUpdateNotification,
        trackedKey: agentName ?? "",
        onRefetch,
    });
}
