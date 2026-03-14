// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------

import {
    Box,
    Button,
    Modal,
    SpaceBetween,
    Alert,
} from "@cloudscape-design/components";
import { Evaluator } from "../../../common/types";

interface DeleteEvaluatorModalProps {
    visible: boolean;
    onDismiss: () => void;
    evaluator: Evaluator;
    onDelete: () => void;
    isDeleting: boolean;
}

export default function DeleteEvaluatorModal({
    visible,
    onDismiss,
    evaluator,
    onDelete,
    isDeleting,
}: DeleteEvaluatorModalProps) {
    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header="Delete Evaluator"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={onDismiss} disabled={isDeleting}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={onDelete}
                            loading={isDeleting}
                        >
                            Delete
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="m">
                <Alert type="warning">
                    This action cannot be undone. All evaluation history and results for this evaluator will be permanently deleted.
                </Alert>
                <Box>
                    Are you sure you want to delete the evaluator <strong>{evaluator.name}</strong>?
                </Box>
                <Box variant="small" color="text-body-secondary">
                    Evaluator ID: {evaluator.evaluatorId}
                </Box>
            </SpaceBetween>
        </Modal>
    );
}
