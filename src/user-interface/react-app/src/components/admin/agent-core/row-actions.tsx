// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------

import { ButtonDropdown, ButtonDropdownProps } from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import { canMutate } from "./runtime-status";

/** Stable ids for each row action; used as ButtonDropdown item ids and in the click switch. */
export type RowActionId =
    | "new-version"
    | "tag-version"
    | "set-favorite"
    | "view"
    | "start-session"
    | "update-container"
    | "delete";

export interface RowActionsProps {
    /** The agent row this menu acts on. */
    item: RuntimeSummary;
    /**
     * Invoked with the chosen action id and the row item. The parent
     * (agent-core-runtime-manager) owns the handlers and any modals/navigation.
     */
    onAction: (id: RowActionId, item: RuntimeSummary) => void;
    /** True while a mutation for this row is in flight (disables destructive items). */
    busy?: boolean;
}

/**
 * Per-row `⋯` action menu. Renders a Cloudscape ButtonDropdown whose items are
 * the selection-scoped actions. Item enablement reflects the row's state: while
 * the runtime is in a transient (in-progress) status — or a mutation for the row
 * is already in flight — the mutating actions are disabled. "View" stays enabled
 * so a busy/transient agent can still be inspected.
 */
export default function RowActions({ item, onAction, busy }: RowActionsProps) {
    const mutable = canMutate(item.status) && !busy;

    const items: ButtonDropdownProps.Item[] = [
        { id: "start-session", text: "Start a session", iconName: "contact", disabled: !mutable },
        { id: "view", text: "View", iconName: "zoom-in" },
        { id: "new-version", text: "New version", iconName: "copy", disabled: !mutable },
        { id: "tag-version", text: "Tag version", iconName: "flag", disabled: !mutable },
        { id: "set-favorite", text: "Set as Favorite", iconName: "star", disabled: !mutable },
        {
            id: "update-container",
            text: "Update container",
            iconName: "upload",
            disabled: !mutable,
        },
        { id: "delete", text: "Delete", iconName: "remove", disabled: !mutable },
    ];

    return (
        <ButtonDropdown
            items={items}
            variant="icon"
            ariaLabel={`Actions for ${item.agentName}`}
            expandableGroups={false}
            // Render the menu in a viewport-level portal so it isn't clipped by
            // the table row/cell overflow (Cloudscape dropdowns inside tables).
            expandToViewport
            onItemClick={({ detail }: { detail: ButtonDropdownProps.ItemClickDetails }) =>
                onAction(detail.id as RowActionId, item)
            }
        />
    );
}
