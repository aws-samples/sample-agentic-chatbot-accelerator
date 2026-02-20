// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Box,
    Button,
    FormField,
    Input,
    Modal,
    Select,
    SpaceBetween,
    Textarea,
} from "@cloudscape-design/components";
import { useState } from "react";

interface TagVersionModalProps {
    visible: boolean;
    onDismiss: () => void;
    onSubmit: (data: { version: string; tagName: string; description?: string }) => void;
    agentName: string;
    availableVersions: string[];
    isLoading?: boolean;
}

export default function TagVersionModal({
    visible,
    onDismiss,
    onSubmit,
    agentName,
    availableVersions,
    isLoading = false,
}: TagVersionModalProps) {
    const [selectedVersion, setSelectedVersion] = useState<string>("");
    const [tagName, setTagName] = useState<string>("");
    const [description, setDescription] = useState<string>("");

    const handleSubmit = () => {
        onSubmit({
            version: selectedVersion,
            tagName,
            description: description || undefined,
        });
    };

    const isValid = selectedVersion && tagName;

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header="Tag Version"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={onDismiss}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSubmit}
                            disabled={!isValid}
                            loading={isLoading}
                        >
                            Tag Version
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                <FormField label="Agent Name">
                    <Input value={agentName} disabled />
                </FormField>

                <FormField label="Version" constraintText="Select the version to tag">
                    <Select
                        selectedOption={
                            selectedVersion
                                ? { label: selectedVersion, value: selectedVersion }
                                : null
                        }
                        onChange={({ detail }) =>
                            setSelectedVersion(detail.selectedOption?.value || "")
                        }
                        options={availableVersions.map((v) => ({ label: v, value: v }))}
                        placeholder="Select version"
                    />
                </FormField>

                <FormField label="Tag Name" constraintText="Enter a name for this tag">
                    <Input
                        value={tagName}
                        onChange={({ detail }) => setTagName(detail.value)}
                        placeholder="e.g., production, staging, v1.0"
                    />
                </FormField>

                <FormField
                    label="Description (Optional)"
                    constraintText="Optional description for this tag"
                >
                    <Textarea
                        value={description}
                        onChange={({ detail }) => setDescription(detail.value)}
                        placeholder="Enter description..."
                        rows={3}
                    />
                </FormField>
            </SpaceBetween>
        </Modal>
    );
}
