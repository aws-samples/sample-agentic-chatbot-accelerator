// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Box, Button, Modal, SpaceBetween } from "@cloudscape-design/components";

export default function ConfirmModal({
    visible,
    header,
    onDismiss,
    onConfirm,
    confirmLabel = "Delete",
    cancelLabel = "Cancel",
    loading,
    disabled,
    children,
}: {
    visible: boolean;
    header: string;
    onDismiss: () => void;
    onConfirm: () => void;
    confirmLabel?: string;
    cancelLabel?: string;
    loading?: boolean;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header={header}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={onDismiss} disabled={loading}>
                            {cancelLabel}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={onConfirm}
                            loading={loading}
                            disabled={disabled}
                        >
                            {confirmLabel}
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            {children}
        </Modal>
    );
}
