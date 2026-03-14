// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------

import {
    Box,
    Button,
    ColumnLayout,
    Container,
    Header,
    Modal,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { Evaluator, EvaluationSummary } from "../../../common/types";

interface ViewResultsModalProps {
    visible: boolean;
    onDismiss: () => void;
    evaluator: Evaluator;
    results: EvaluationSummary;
}

export default function ViewResultsModal({
    visible,
    onDismiss,
    evaluator,
    results,
}: ViewResultsModalProps) {
    const passRate = results.totalCases > 0
        ? (results.passedCases / results.totalCases) * 100
        : 0;

    const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    };

    const getPassRateColor = (rate: number): "success" | "warning" | "error" => {
        if (rate >= 80) return "success";
        if (rate >= 50) return "warning";
        return "error";
    };

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header={`Evaluation Results: ${evaluator.name}`}
            size="max"
            footer={
                <Box float="right">
                    <Button variant="primary" onClick={onDismiss}>
                        Close
                    </Button>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                {/* Summary Metrics - Key Value Pairs */}
                <Container header={<Header variant="h3">Summary</Header>}>
                    <ColumnLayout columns={2} variant="text-grid">
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Status</Box>
                                <StatusIndicator
                                    type={results.status === "Completed" ? "success" : results.status === "Failed" ? "error" : "loading"}
                                >
                                    {results.status}
                                </StatusIndicator>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Pass Rate</Box>
                                <StatusIndicator type={getPassRateColor(passRate)}>
                                    {passRate.toFixed(1)}%
                                </StatusIndicator>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Duration</Box>
                                <Box>{formatDuration(results.totalTimeMs)}</Box>
                            </div>
                        </SpaceBetween>
                        <SpaceBetween direction="vertical" size="s">
                            <div>
                                <Box variant="awsui-key-label">Total Test Cases</Box>
                                <Box>{results.totalCases}</Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Passed</Box>
                                <Box color="text-status-success">{results.passedCases}</Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Failed</Box>
                                <Box color="text-status-error">{results.totalCases - results.passedCases}</Box>
                            </div>
                        </SpaceBetween>
                    </ColumnLayout>
                </Container>

                {/* Results Table */}
                <Container header={<Header variant="h3">Test Case Results</Header>}>
                    <Table
                        items={results.results}
                        columnDefinitions={[
                            {
                                id: "caseName",
                                header: "Case Name",
                                cell: (item) => item.caseName,
                                width: 150,
                            },
                            {
                                id: "score",
                                header: "Score",
                                cell: (item) => (
                                    <StatusIndicator
                                        type={item.score >= 80 ? "success" : item.score >= 50 ? "warning" : "error"}
                                    >
                                        {item.score}%
                                    </StatusIndicator>
                                ),
                                width: 100,
                            },
                            {
                                id: "passed",
                                header: "Pass/Fail",
                                cell: (item) => (
                                    <StatusIndicator type={item.passed ? "success" : "error"}>
                                        {item.passed ? "Passed" : "Failed"}
                                    </StatusIndicator>
                                ),
                                width: 100,
                            },
                            {
                                id: "reason",
                                header: "Evaluator Feedback",
                                cell: (item) => <ReasonCell reason={item.reason} />,
                                width: 450,
                            },
                            {
                                id: "latency",
                                header: "Latency",
                                cell: (item) => item.latencyMs ? `${item.latencyMs}ms` : "-",
                                width: 100,
                            },
                        ]}
                        variant="embedded"
                        stripedRows
                        stickyHeader
                    />
                </Container>
            </SpaceBetween>
        </Modal>
    );
}

/**
 * Component to render the reason cell with proper formatting for multiple evaluators.
 * Handles the format: [EvaluatorType1] reason1\n[EvaluatorType2] reason2
 */
function ReasonCell({ reason }: { reason: string }) {
    if (!reason) return <span>-</span>;

    // Parse evaluator results from the combined reason string
    // Format: [EvaluatorType] reason text\n[AnotherType] more text
    const parts: { evaluator: string; text: string }[] = [];

    // Split the reason into evaluator-labeled sections
    const lines = reason.split("\n");

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Check if line starts with [EvaluatorType]
        const evalMatch = trimmedLine.match(/^\[([^\]]+)\]\s*(.*)/);
        if (evalMatch) {
            const [, evaluator, text] = evalMatch;
            parts.push({
                evaluator: evaluator.replace(/Evaluator$/, ""), // Remove "Evaluator" suffix
                text: text || "",
            });
        } else if (parts.length > 0) {
            // Append to last evaluator's text
            parts[parts.length - 1].text += (parts[parts.length - 1].text ? " " : "") + trimmedLine;
        } else {
            // No evaluator prefix, add as generic entry
            parts.push({ evaluator: "", text: trimmedLine });
        }
    }

    // If no evaluator prefixes found, just show the raw text
    if (parts.length === 0 || (parts.length === 1 && !parts[0].evaluator)) {
        return (
            <Box fontSize="body-s">
                <pre style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "inherit",
                    fontSize: "12px",
                }}>
                    {reason}
                </pre>
            </Box>
        );
    }

    // Render each evaluator's feedback separately
    return (
        <SpaceBetween direction="vertical" size="xs">
            {parts.map((part, index) => (
                <Box key={index} fontSize="body-s">
                    {part.evaluator && (
                        <Box fontWeight="bold" color="text-status-info" fontSize="body-s">
                            [{part.evaluator}]
                        </Box>
                    )}
                    <Box fontSize="body-s" color="text-body-secondary">
                        {part.text || "-"}
                    </Box>
                </Box>
            ))}
        </SpaceBetween>
    );
}
