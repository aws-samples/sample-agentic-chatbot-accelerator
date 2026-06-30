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
    ExpandableSection,
    Header,
    Modal,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { useState } from "react";
import { Evaluator, EvaluationResult, EvaluationSummary } from "../../../common/types";

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
    const [expandedItems, setExpandedItems] = useState<EvaluationResult[]>([]);

    const passRate = results.totalCases > 0
        ? (results.passedCases / results.totalCases) * 100
        : 0;

    // Cases the evaluator(s) could not score because none applied to this agent.
    const skippedCount =
        results.skippedCases ??
        results.results.filter((r) => r.status === "skipped").length;
    // Failed = total minus passed minus skipped (skipped is not a failure).
    const failedCount = Math.max(
        results.totalCases - results.passedCases - skippedCount,
        0,
    );

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
                                <Box color="text-status-error">{failedCount}</Box>
                            </div>
                            {skippedCount > 0 && (
                                <div>
                                    <Box variant="awsui-key-label">Skipped (not applicable)</Box>
                                    <Box color="text-status-inactive">{skippedCount}</Box>
                                </div>
                            )}
                        </SpaceBetween>
                    </ColumnLayout>
                </Container>

                {/* Results Table */}
                <Container header={<Header variant="h3">Test Case Results</Header>}>
                    <Table
                        items={results.results}
                        trackBy="caseName"
                        expandableRows={{
                            getItemChildren: () => [],
                            isItemExpandable: () => true,
                            expandedItems: expandedItems,
                            onExpandableItemToggle: ({ detail }) => {
                                setExpandedItems((prev) =>
                                    detail.expanded
                                        ? [...prev, detail.item]
                                        : prev.filter((i) => i.caseName !== detail.item.caseName),
                                );
                            },
                        }}
                        columnDefinitions={[
                            {
                                id: "caseName",
                                header: "Case Name",
                                cell: (item) => item.caseName,
                                width: 200,
                            },
                            {
                                id: "score",
                                header: "Score",
                                cell: (item) => (
                                    item.status === "skipped" ? (
                                        <StatusIndicator type="info">N/A</StatusIndicator>
                                    ) : (
                                        <StatusIndicator
                                            type={item.score >= 80 ? "success" : item.score >= 50 ? "warning" : "error"}
                                        >
                                            {item.score}%
                                        </StatusIndicator>
                                    )
                                ),
                                width: 100,
                            },
                            {
                                id: "passed",
                                header: "Result",
                                cell: (item) => (
                                    item.status === "skipped" ? (
                                        <StatusIndicator type="info">Skipped</StatusIndicator>
                                    ) : (
                                        <StatusIndicator type={item.passed ? "success" : "error"}>
                                            {item.passed ? "Passed" : "Failed"}
                                        </StatusIndicator>
                                    )
                                ),
                                width: 100,
                            },
                            {
                                id: "detail",
                                header: "Details",
                                cell: (item) =>
                                    expandedItems.some((i) => i.caseName === item.caseName) ? (
                                        <CaseDetail item={item} />
                                    ) : (
                                        <Box color="text-status-inactive" fontSize="body-s">
                                            Expand to see input, expected & actual output and feedback
                                        </Box>
                                    ),
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
                        wrapLines
                    />
                </Container>
            </SpaceBetween>
        </Modal>
    );
}

/**
 * Per-case detail panel: shows the input, expected output, the actual agent
 * output that was evaluated, and the evaluator feedback.
 */
function CaseDetail({ item }: { item: EvaluationResult }) {
    const reps = item.repetitions || [];
    const isRepeated = (item.repeatCount ?? 1) > 1 && reps.length > 1;

    return (
        <SpaceBetween direction="vertical" size="s">
            <ColumnLayout columns={1} variant="text-grid">
                <div>
                    <Box variant="awsui-key-label">Input</Box>
                    <OutputBlock text={item.input} />
                </div>
                <div>
                    <Box variant="awsui-key-label">Expected Output</Box>
                    <OutputBlock text={item.expectedOutput} />
                </div>
                {!isRepeated && (
                    <div>
                        <Box variant="awsui-key-label">Actual Output (evaluated)</Box>
                        <OutputBlock text={item.actualOutput} />
                    </div>
                )}
            </ColumnLayout>

            {isRepeated ? (
                <ExpandableSection
                    headerText={`Individual runs (${reps.length}) — score shown is the mean`}
                    defaultExpanded
                >
                    <Table
                        items={reps}
                        variant="embedded"
                        wrapLines
                        columnDefinitions={[
                            {
                                id: "run",
                                header: "Run",
                                cell: (r) => `#${(r.repeatIndex ?? 0) + 1}`,
                                width: 70,
                            },
                            {
                                id: "score",
                                header: "Score",
                                cell: (r) =>
                                    r.status === "skipped" ? (
                                        <StatusIndicator type="info">N/A</StatusIndicator>
                                    ) : (
                                        <StatusIndicator
                                            type={r.score >= 80 ? "success" : r.score >= 50 ? "warning" : "error"}
                                        >
                                            {r.score}%
                                        </StatusIndicator>
                                    ),
                                width: 90,
                            },
                            {
                                id: "actualOutput",
                                header: "Actual Output",
                                cell: (r) => <OutputBlock text={r.actualOutput} />,
                            },
                            {
                                id: "reason",
                                header: "Feedback",
                                cell: (r) => <ReasonCell reason={r.reason || ""} />,
                            },
                        ]}
                    />
                </ExpandableSection>
            ) : (
                <ExpandableSection headerText="Evaluator Feedback" defaultExpanded>
                    <ReasonCell reason={item.reason} />
                </ExpandableSection>
            )}
        </SpaceBetween>
    );
}

/** Renders a possibly-long text value in a wrapped block. */
function OutputBlock({ text }: { text?: string }) {
    if (!text) return <Box color="text-status-inactive">-</Box>;
    return (
        <Box fontSize="body-s">
            <pre
                style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "inherit",
                    fontSize: "12px",
                }}
            >
                {text}
            </pre>
        </Box>
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
