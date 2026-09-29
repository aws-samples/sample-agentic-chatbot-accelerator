// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Box, CollectionPreferences, PropertyFilterProps } from "@cloudscape-design/components";

export function TableEmptyState({
    title,
    subtitle,
    action,
}: {
    title: string;
    subtitle?: string;
    action: React.ReactNode;
}) {
    return (
        <Box textAlign="center" color="inherit">
            <Box variant="strong" textAlign="center" color="inherit">
                {title}
            </Box>
            <Box variant="p" padding={{ bottom: "s" }} color="inherit">
                {subtitle}
            </Box>
            {action}
        </Box>
    );
}

export interface PageSizePreference {
    pageSize: number;
}

export function PageSizePreferences({
    preferences,
    onChange,
}: {
    preferences: PageSizePreference;
    onChange: (preferences: PageSizePreference) => void;
}) {
    return (
        <CollectionPreferences
            onConfirm={({ detail }) => onChange({ pageSize: detail.pageSize ?? 20 })}
            title="Preferences"
            confirmLabel="Confirm"
            cancelLabel="Cancel"
            preferences={preferences}
            pageSizePreference={{
                title: "Page size",
                options: [
                    { value: 10, label: "10" },
                    { value: 20, label: "20" },
                    { value: 50, label: "50" },
                ],
            }}
        />
    );
}

export function filterProperty(
    key: string,
    propertyLabel: string,
    groupValuesLabel = `${propertyLabel} values`,
): PropertyFilterProps.FilteringProperty {
    return {
        key,
        propertyLabel,
        groupValuesLabel,
        operators: [":", "!:", "=", "!="],
    };
}
