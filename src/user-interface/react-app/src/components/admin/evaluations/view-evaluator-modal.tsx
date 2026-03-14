// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------

import {
    Badge,
    Box,
    Button,
    ColumnLayout,
    Container,
    ExpandableSection,
    Header,
    Modal,
    SpaceBetween,
    StatusIndicator,
} from "@cloudscape-design/components";
import { Evaluator } from "../../../common/types";

interface ViewEvaluatorModalProps {
    visible: boolean;
    onDismiss: () => void;
    evaluator: Evaluator;
}

// Helper to format evaluator type names
const formatEvaluatorType = (type: string): string => {
    return type.replace(/Evaluator$/, "");
};

export default function ViewEvaluatorModal({
    visible,
    onDismiss,
    evaluator,
}: ViewEvaluatorModalProps) {
    const getStatusType = (status?: string): "success" | "warning" | "error" | "loading" | "info" => {
        if (!status) return "info";
        const lowerStatus = status.toLowerCase();
        if (lowerStatus === "creating" || lowerStatus === "running" || lowerStatus.endsWith("ing")) return "loading";
        if (lowerStatus === "ready" || lowerStatus === "completed" || lowerStatus === "passed") return "success";
        if (lowerStatus === "failed") return "error";
        return "info";
    };

    const formatDate = (dateStr?: string): string => {
        if (!dateStr) return "-";
        return new Date(dateStr).toLocaleString();
    };

    // Parse evaluator types (can be comma-separated for multiple types)
    const evaluatorTypes = evaluator.evaluatorType?.split(",").map((t: string) => t.trim()) || [];

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header={`Evaluator: ${evaluator.name}`}
            size="large"
            footer={
                <Box float="right">
                    <Button variant="primary" onClick={onDismiss}>
                        Close
                    </Button>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                {/* Basic Information */}
                <Container header={<Header variant="h3">Basic Information</Header>}>
                    <ColumnLayout columns={2} variant="text-grid">
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Evaluator ID</Box>
                                <Box>{evaluator.evaluatorId}</Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Name</Box>
                                <Box>{evaluator.name}</Box>
                            </div>
                        </SpaceBetween>
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Status</Box>
                                <StatusIndicator type={getStatusType(evaluator.status)}>
                                    {evaluator.status}
                                </StatusIndicator>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Created At</Box>
                                <Box>{formatDate(evaluator.createdAt)}</Box>
                            </div>
                        </SpaceBetween>
                    </ColumnLayout>
                </Container>

                {/* Evaluator Types */}
                <Container header={<Header variant="h3">Evaluator Types ({evaluatorTypes.length})</Header>}>
                    <SpaceBetween direction="horizontal" size="xs">
                        {evaluatorTypes.map((type, index) => (
                            <Badge key={index} color="blue">
                                {formatEvaluatorType(type)}
                            </Badge>
                        ))}
                    </SpaceBetween>
                </Container>

                {/* Agent Configuration */}
                <Container header={<Header variant="h3">Agent Configuration</Header>}>
                    <ColumnLayout columns={2} variant="text-grid">
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Agent Runtime</Box>
                                <Box>{evaluator.agentRuntimeName || "-"}</Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Qualifier/Endpoint</Box>
                                <Box>{evaluator.qualifier || "-"}</Box>
                            </div>
                        </SpaceBetween>
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Test Cases Count</Box>
                                <Box>{evaluator.testCasesCount || 0}</Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Test Cases S3 Path</Box>
                                <Box fontSize="body-s">
                                    {evaluator.testCasesS3Path || "-"}
                                </Box>
                            </div>
                        </SpaceBetween>
                    </ColumnLayout>
                </Container>

                {/* Rubrics (if exists) */}
                {evaluator.customRubric && (
                    <ExpandableSection headerText="Rubrics" defaultExpanded={false}>
                        <Box
                            padding="s"
                            variant="code"
                        >
                            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "12px" }}>
                                {evaluator.customRubric}
                            </pre>
                        </Box>
                    </ExpandableSection>
                )}

                {/* Execution Details (if run) */}
                {(evaluator.startedAt || evaluator.completedAt) && (
                    <Container header={<Header variant="h3">Execution Details</Header>}>
                        <ColumnLayout columns={2} variant="text-grid">
                            <SpaceBetween direction="vertical" size="s">
                                <div>
                                    <Box variant="awsui-key-label">Started At</Box>
                                    <Box>{formatDate(evaluator.startedAt)}</Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Completed At</Box>
                                    <Box>{formatDate(evaluator.completedAt)}</Box>
                                </div>
                            </SpaceBetween>
                            <SpaceBetween direction="vertical" size="s">
                                <div>
                                    <Box variant="awsui-key-label">Passed Cases</Box>
                                    <Box color="text-status-success">{evaluator.passedCases ?? 0}</Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Failed Cases</Box>
                                    <Box color="text-status-error">{evaluator.failedCases ?? 0}</Box>
                                </div>
                            </SpaceBetween>
                        </ColumnLayout>
                    </Container>
                )}

                {/* Error Message (if failed) */}
                {evaluator.errorMessage && (
                    <Container header={<Header variant="h3">Error</Header>}>
                        <Box color="text-status-error">
                            {evaluator.errorMessage}
                        </Box>
                    </Container>
                )}
            </SpaceBetween>
        </Modal>
    );
}
