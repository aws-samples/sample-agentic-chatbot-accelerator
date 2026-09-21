// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------

import { useRuntimeUpdateWatcher } from "../../../common/hooks/use-runtime-update-watcher";

interface RuntimeUpdateWatcherProps {
    readonly agentName: string;
    readonly onRefetch: () => void | Promise<void>;
}

/**
 * One mounted watcher per in-flight agent. Renders nothing; exists so a table of N rows can
 * hold N subscriptions without breaking rules-of-hooks. Key it on `agentName`.
 */
export default function RuntimeUpdateWatcher(props: RuntimeUpdateWatcherProps) {
    useRuntimeUpdateWatcher({
        agentName: props.agentName,
        onRefetch: props.onRefetch,
    });

    return null;
}
