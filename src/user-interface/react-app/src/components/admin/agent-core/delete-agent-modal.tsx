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

interface DeleteAgentModalProps {
    visible: boolean;
    onDismiss: () => void;
    selectedItem: RuntimeSummary;
    onDelete: (deleteMode: "all" | "specific", selectedQualifiers?: string[]) => Promise<void>;
    isDeleting: boolean;
}

export default function DeleteAgentModal({
    visible,
    onDismiss,
    selectedItem,
    onDelete,
    isDeleting,
}: DeleteAgentModalProps) {
    const [deleteMode, setDeleteMode] = useState<"all" | "specific">("all");
    const [selectedQualifiersToDelete, setSelectedQualifiersToDelete] = useState<string[]>([]);

    const handleDismiss = () => {
        setDeleteMode("all");
        setSelectedQualifiersToDelete([]);
        onDismiss();
    };

    const handleDeleteConfirm = async () => {
        await onDelete(deleteMode, selectedQualifiersToDelete);
        handleDismiss();
    };

    // Get qualifiers for single agent selection
    // Get qualifiers for single agent selection, excluding protected ones
    const qualifiers = Object.keys(JSON.parse(selectedItem.qualifierToVersion)).filter(
        (qualifier) => qualifier !== "DEFAULT",
    );

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
            header="Delete Agent"
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
                                deleteMode === "specific" && selectedQualifiersToDelete.length === 0
                            }
                        >
                            Delete
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween size="m">
                <Alert type="warning">
                    This action cannot be undone. Please confirm what you want to delete.
                </Alert>

                <Box>
                    <SpaceBetween size="m">
                        <Box variant="strong">Agent: {selectedItem.agentName}</Box>
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
                                    No deletable endpoints available. All endpoints are protected.
                                </Box>
                            ) : (
                                qualifiers.map((qualifier) => (
                                    <Checkbox
                                        key={qualifier}
                                        checked={selectedQualifiersToDelete.includes(qualifier)}
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
            </SpaceBetween>
        </Modal>
    );
}
