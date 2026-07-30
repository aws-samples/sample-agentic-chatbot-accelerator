// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    Checkbox,
    FormField,
    Modal,
    RadioGroup,
    SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect, useState } from "react";
import { RuntimeSummary } from "../../../API";
import { isTransientStatus } from "./runtime-status";

interface DeleteAgentModalProps {
    visible: boolean;
    onDismiss: () => void;
    /** One agent → endpoint-picker mode. Multiple → whole-agent mode (no picker). */
    selectedItems: RuntimeSummary[];
    /**
     * deleteMode is forced to "all" (whole-agent) when selectedItems.length > 1.
     * selectedQualifiers is only meaningful in single-select "specific" mode.
     */
    onDelete: (deleteMode: "all" | "specific", selectedQualifiers?: string[]) => Promise<void>;
    isDeleting: boolean;
}

export default function DeleteAgentModal({
    visible,
    onDismiss,
    selectedItems,
    onDelete,
    isDeleting,
}: DeleteAgentModalProps) {
    const [deleteMode, setDeleteMode] = useState<"all" | "specific">("all");
    const [selectedQualifiersToDelete, setSelectedQualifiersToDelete] = useState<string[]>([]);

    const isMulti = selectedItems.length > 1;
    const singleItem = selectedItems[0];

    // Get deletable qualifiers for single-agent selection, excluding protected DEFAULT.
    // In multi mode there is no picker, so this stays empty.
    const qualifiers = isMulti
        ? []
        : Object.keys(JSON.parse(singleItem.qualifierToVersion)).filter(
              (qualifier) => qualifier !== "DEFAULT",
          );

    const handleDismiss = () => {
        setDeleteMode("all");
        setSelectedQualifiersToDelete([]);
        onDismiss();
    };

    // A control-plane op may start (e.g. a background refresh flips a row to
    // Deleting/Updating) while this modal is open — re-check on every render so
    // confirm is blocked the moment any targeted agent goes transient.
    const isTransient = selectedItems.some((item) => isTransientStatus(item.status));

    const handleDeleteConfirm = async () => {
        if (isTransient) return;
        // Multi-select is always whole-agent; the picker is single-select only.
        await onDelete(isMulti ? "all" : deleteMode, selectedQualifiersToDelete);
        handleDismiss();
    };

    // Clear selected qualifiers when available qualifiers change
    useEffect(() => {
        setSelectedQualifiersToDelete((prev) =>
            prev.filter((selected) => qualifiers.includes(selected)),
        );
    }, [qualifiers]);

    return (
        <Modal
            visible={visible}
            onDismiss={handleDismiss}
            header={isMulti ? `Delete ${selectedItems.length} Agents` : "Delete Agent"}
            size="medium"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button onClick={handleDismiss}>Cancel</Button>
                        <Button
                            variant="primary"
                            onClick={handleDeleteConfirm}
                            loading={isDeleting}
                            disabled={
                                isTransient ||
                                (!isMulti &&
                                    deleteMode === "specific" &&
                                    selectedQualifiersToDelete.length === 0)
                            }
                        >
                            Delete
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween size="m">
                {isTransient ? (
                    <Alert type="warning">
                        {isMulti
                            ? "One or more selected agents have an operation in progress. Wait for them to finish before deleting."
                            : `This agent is currently ${singleItem.status}. Wait for the operation to finish before deleting.`}
                    </Alert>
                ) : (
                    <Alert type="warning">
                        This action cannot be undone. Please confirm what you want to delete.
                    </Alert>
                )}

                {isMulti ? (
                    <SpaceBetween size="m">
                        <Box>
                            This deletes <strong>{selectedItems.length} entire agents</strong> and
                            all of their endpoints:
                        </Box>
                        <ul>
                            {selectedItems.map((item) => (
                                <li key={item.agentRuntimeId}>{item.agentName}</li>
                            ))}
                        </ul>
                    </SpaceBetween>
                ) : (
                    <>
                        <Box>
                            <SpaceBetween size="m">
                                <Box variant="strong">Agent: {singleItem.agentName}</Box>
                                <Box variant="small">Total endpoints: {qualifiers.length}</Box>
                            </SpaceBetween>
                        </Box>

                        <FormField label="Delete options">
                            <RadioGroup
                                value={deleteMode}
                                onChange={({ detail }) => {
                                    setDeleteMode(detail.value as "all" | "specific");
                                    setSelectedQualifiersToDelete([]);
                                }}
                                items={[
                                    {
                                        value: "all",
                                        label: "Delete entire agent (all endpoints)",
                                    },
                                    ...[
                                        {
                                            value: "specific" as const,
                                            label: "Delete specific endpoints only",
                                        },
                                    ],
                                ]}
                            />
                        </FormField>

                        {deleteMode === "specific" && (
                            <FormField
                                label="Select endpoints to delete"
                                description="Choose which endpoints you want to delete"
                            >
                                <SpaceBetween size="s">
                                    <Alert type="info">
                                        The `DEFAULT` endpoint is protected, and cannot be deleted.
                                    </Alert>
                                    {qualifiers.length === 0 ? (
                                        <Box color="text-status-inactive">
                                            No deletable endpoints available. All endpoints are
                                            protected.
                                        </Box>
                                    ) : (
                                        qualifiers.map((qualifier) => (
                                            <Checkbox
                                                key={qualifier}
                                                checked={selectedQualifiersToDelete.includes(
                                                    qualifier,
                                                )}
                                                onChange={({ detail }) => {
                                                    if (detail.checked) {
                                                        setSelectedQualifiersToDelete((prev) => [
                                                            ...prev,
                                                            qualifier,
                                                        ]);
                                                    } else {
                                                        setSelectedQualifiersToDelete((prev) =>
                                                            prev.filter((q) => q !== qualifier),
                                                        );
                                                    }
                                                }}
                                            >
                                                {qualifier}
                                            </Checkbox>
                                        ))
                                    )}
                                </SpaceBetween>
                            </FormField>
                        )}
                    </>
                )}
            </SpaceBetween>
        </Modal>
    );
}
