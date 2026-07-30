// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------

/**
 * A runtime is "transient" when a control-plane operation is in progress and
 * mutating actions (Delete, Update container, Tag, New version) must be blocked.
 *
 * Matched by shape rather than an exact allow-list: any status ending in "ing"
 * (Creating, Updating, Deleting) is in-progress — mirroring the status cell's
 * loading branch. Ready, failed, and broken are NOT transient (failed/broken
 * agents are intentionally deletable for cleanup). Keying on the string shape
 * means future-persisted transient values are handled without a backend change.
 */
export function isTransientStatus(status: string): boolean {
    return status.trim().toLowerCase().endsWith("ing");
}

/**
 * Convenience predicate: may a destructive/mutating action run against this row?
 * Currently equivalent to `!isTransientStatus`, but named for intent so call
 * sites read clearly and the rule can evolve in one place.
 */
export function canMutate(status: string): boolean {
    return !isTransientStatus(status);
}
