// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

export function formatDate(value: string | null | undefined): string {
    if (!value) return "-";
    return new Date(value).toLocaleString();
}

// 0 means no case reported a latency (e.g. every case failed), not an instant run.
export function formatDuration(ms: number | null | undefined): string {
    if (!ms) return "-";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}
