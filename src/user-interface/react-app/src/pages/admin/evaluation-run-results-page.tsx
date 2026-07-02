// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------
import {
    Box,
    BreadcrumbGroup,
    ColumnLayout,
    Container,
    ExpandableSection,
    Header,
    SpaceBetween,
    Spinner,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import {
    EvaluationResult,
    EvaluationSummary,
    EvaluatorRun,
    EvaluatorScore,
} from "../../common/types";
import { Utils } from "../../common/utils";
import BaseAppLayout from "../../components/base-app-layout";
import { getEvaluatorRun as getEvaluatorRunQuery } from "../../graphql/queries";

// Map a fetched EvaluatorRun onto the summary shape the results rendering
// expects. Mirrors the mapping the run-history modal already performs:
// totalCases falls back to passedCases + failedCases when absent. The optional
// structured per-evaluator breakdown is passed through so the redesigned table
// can render per-evaluator scores/justifications when present.
function toSummary(run: EvaluatorRun): EvaluationSummary {
    return {
        runId: run.runId,
        evaluatorId: run.evaluatorId,
        totalCases:
            run.totalCases ?? (run.passedCases || 0) + (run.failedCases || 0),
        passedCases: run.passedCases || 0,
        skippedCases: run.skippedCases,
        totalTimeMs: run.totalTimeMs || 0,
        status: run.status,
        completedAt: run.completedAt || undefined,
        results: (run.results || []).map(
            (r): EvaluationResult => ({
                caseName: r.caseName,
                input: r.input,
                expectedOutput: r.expectedOutput,
                actualOutput: r.actualOutput,
                score: r.score,
                passed: r.passed,
                status: r.status,
                reason: r.reason,
                latencyMs: r.latencyMs,
                repeatCount: r.repeatCount,
                repetitions: r.repetitions || [],
                evaluatorBreakdown: r.evaluatorBreakdown,
            }),
        ),
    };
}

export default function EvaluationRunResultsPage() {
    const navigate = useNavigate();
    const onFollow = useOnFollow();
    const { evaluatorId, runId } = useParams<{
        evaluatorId: string;
        runId: string;
    }>();
    const apiClient = useMemo(() => generateClient(), []);

    const [isLoading, setIsLoading] = useState(true);
    const [run, setRun] = useState<EvaluatorRun | null>(null);

    useEffect(() => {
        if (!evaluatorId || !runId) {
            navigate("/evaluations");
            return;
        }

        const load = async () => {
            setIsLoading(true);
            try {
                const result = await apiClient.graphql({
                    query: getEvaluatorRunQuery,
                    variables: { evaluatorId, runId },
                });
                const runData = result.data?.getEvaluatorRun;
                if (!runData) {
                    navigate("/evaluations");
                    return;
                }
                setRun(runData as EvaluatorRun);
            } catch (error) {
                console.error(Utils.getErrorMessage(error));
                navigate("/evaluations");
            } finally {
                setIsLoading(false);
            }
        };

        load();
    }, [evaluatorId, runId, apiClient, navigate]);

    const summary = useMemo(() => (run ? toSummary(run) : null), [run]);

    return (
        <BaseAppLayout
            contentType="table"
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        { text: CHATBOT_NAME, href: "/" },
                        { text: "Evaluations", href: "/evaluations" },
                        {
                            text: "Run Results",
                            href: `/evaluations/${evaluatorId}/runs/${runId}`,
                        },
                    ]}
                />
            }
            content={
                isLoading || !summary ? (
                    <Spinner size="large" />
                ) : (
                    <RunResultsContent run={run!} results={summary} />
                )
            }
        />
    );
}

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

// Shared score → StatusIndicator color mapping (>=80 success, >=50 warning,
// else error).
const getScoreColor = (score: number): "success" | "warning" | "error" =>
    score >= 80 ? "success" : score >= 50 ? "warning" : "error";

// Human-readable evaluator label: drop the trailing "Evaluator" suffix.
const evaluatorLabel = (evaluatorType: string): string =>
    evaluatorType.replace(/Evaluator$/, "") || evaluatorType;

/**
 * Renders the score cell for a case/evaluator, distinguishing the three
 * statuses:
 *  - skipped → "N/A" (info; not a failure — R4 AC-6)
 *  - error   → "Error" (error indicator, distinct from a scored fail — R4 AC-7)
 *  - scored  → the numeric score with success/warning/error coloring
 */
function ScoreIndicator({
    status,
    score,
}: {
    status?: string | null;
    score?: number | null;
}) {
    if (status === "skipped") {
        return <StatusIndicator type="info">N/A</StatusIndicator>;
    }
    if (status === "error") {
        return <StatusIndicator type="error">Error</StatusIndicator>;
    }
    if (score === undefined || score === null) {
        return <StatusIndicator type="info">N/A</StatusIndicator>;
    }
    return (
        <StatusIndicator type={getScoreColor(score)}>{score}%</StatusIndicator>
    );
}

/**
 * Renders the pass/fail Result cell, distinguishing skipped ("Not applicable")
 * and error ("Error") from a scored pass/fail.
 */
function ResultIndicator({
    status,
    passed,
}: {
    status?: string | null;
    passed?: boolean | null;
}) {
    if (status === "skipped") {
        return <StatusIndicator type="info">Not applicable</StatusIndicator>;
    }
    if (status === "error") {
        return <StatusIndicator type="error">Error</StatusIndicator>;
    }
    return (
        <StatusIndicator type={passed ? "success" : "error"}>
            {passed ? "Passed" : "Failed"}
        </StatusIndicator>
    );
}

/**
 * Full-width results rendering: a summary Container (including run provenance)
 * followed by the redesigned per-case results Table with dedicated Input /
 * Expected columns and per-evaluator scores.
 */
function RunResultsContent({
    run,
    results,
}: {
    run: EvaluatorRun;
    results: EvaluationSummary;
}) {
    const [expandedItems, setExpandedItems] = useState<EvaluationResult[]>([]);

    const passRate =
        results.totalCases > 0
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

    // Run provenance version: prefer the value stamped on the run at run time.
    // Absent on older runs → explicit "Unknown version" (R3 AC-4).
    const resolvedVersion = run.runtimeVersion
        ? `Version ${run.runtimeVersion}`
        : "Unknown version";

    return (
        <SpaceBetween direction="vertical" size="l">
            <Header variant="h1" description={`Run ${run.runId}`}>
                {`Evaluation Results: ${run.evaluatorName || run.evaluatorId}`}
            </Header>

            {/* Summary Metrics - Key Value Pairs */}
            <Container header={<Header variant="h3">Summary</Header>}>
                <ColumnLayout columns={3} variant="text-grid">
                    <SpaceBetween direction="vertical" size="s">
                        <div>
                            <Box variant="awsui-key-label">Status</Box>
                            <StatusIndicator
                                type={
                                    results.status === "Completed"
                                        ? "success"
                                        : results.status === "Failed"
                                          ? "error"
                                          : "loading"
                                }
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
                            <Box color="text-status-success">
                                {results.passedCases}
                            </Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Failed</Box>
                            <Box color="text-status-error">{failedCount}</Box>
                        </div>
                        {skippedCount > 0 && (
                            <div>
                                <Box variant="awsui-key-label">
                                    Skipped (not applicable)
                                </Box>
                                <Box color="text-status-inactive">
                                    {skippedCount}
                                </Box>
                            </div>
                        )}
                    </SpaceBetween>
                    {/* Run provenance: which agent runtime/endpoint/version ran */}
                    <SpaceBetween direction="vertical" size="s">
                        <div>
                            <Box variant="awsui-key-label">Agent Runtime</Box>
                            <Box>{run.agentRuntimeName || "-"}</Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Endpoint (qualifier)</Box>
                            <Box>{run.qualifier || "-"}</Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Resolved Version</Box>
                            {run.runtimeVersion ? (
                                <Box>{resolvedVersion}</Box>
                            ) : (
                                <StatusIndicator type="info">
                                    {resolvedVersion}
                                </StatusIndicator>
                            )}
                        </div>
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
                                    : prev.filter(
                                          (i) =>
                                              i.caseName !== detail.item.caseName,
                                      ),
                            );
                        },
                    }}
                    columnDefinitions={[
                        {
                            id: "caseName",
                            header: "Case Name",
                            cell: (item) => item.caseName,
                            width: 180,
                        },
                        {
                            id: "input",
                            header: "Input",
                            cell: (item) => <ClampedText text={item.input} />,
                            width: 240,
                        },
                        {
                            id: "expectedOutput",
                            header: "Expected Output",
                            cell: (item) => (
                                <ClampedText text={item.expectedOutput} />
                            ),
                            width: 240,
                        },
                        {
                            id: "score",
                            header: "Score",
                            cell: (item) => (
                                <ScoreIndicator
                                    status={item.status}
                                    score={item.score}
                                />
                            ),
                            width: 100,
                        },
                        {
                            id: "passed",
                            header: "Result",
                            cell: (item) => (
                                <ResultIndicator
                                    status={item.status}
                                    passed={item.passed}
                                />
                            ),
                            width: 130,
                        },
                        {
                            id: "latency",
                            header: "Latency",
                            cell: (item) =>
                                item.latencyMs ? `${item.latencyMs}ms` : "-",
                            width: 100,
                        },
                        {
                            id: "detail",
                            header: "Details",
                            cell: (item) =>
                                expandedItems.some(
                                    (i) => i.caseName === item.caseName,
                                ) ? (
                                    <CaseDetail item={item} />
                                ) : (
                                    <Box
                                        color="text-status-inactive"
                                        fontSize="body-s"
                                    >
                                        Expand to see per-evaluator scores,
                                        actual output & feedback
                                    </Box>
                                ),
                        },
                    ]}
                    variant="embedded"
                    stripedRows
                    stickyHeader
                    wrapLines
                />
            </Container>
        </SpaceBetween>
    );
}

/**
 * Per-case detail panel: shows the input, expected output, the actual agent
 * output that was evaluated, the structured per-evaluator breakdown (scores +
 * justifications), and — when repeated — the individual repetitions.
 */
function CaseDetail({ item }: { item: EvaluationResult }) {
    const reps = item.repetitions || [];
    const isRepeated = (item.repeatCount ?? 1) > 1 && reps.length > 1;
    const breakdown = item.evaluatorBreakdown || [];
    const hasBreakdown = breakdown.length > 0;

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

            {/* Per-evaluator scores + structured justifications (R4 AC-3, AC-8).
                Prefer the structured breakdown; fall back to the combined
                reason-string parse for older runs that lack it. */}
            {hasBreakdown ? (
                <ExpandableSection
                    headerText={`Per-evaluator breakdown (${breakdown.length})`}
                    defaultExpanded
                >
                    <EvaluatorBreakdown breakdown={breakdown} />
                </ExpandableSection>
            ) : (
                <ExpandableSection headerText="Evaluator Feedback" defaultExpanded>
                    <ReasonCell reason={item.reason} />
                </ExpandableSection>
            )}

            {isRepeated && (
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
                                cell: (r) => (
                                    <ScoreIndicator
                                        status={r.status}
                                        score={r.score}
                                    />
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
            )}
        </SpaceBetween>
    );
}

/**
 * Structured per-evaluator breakdown: one labeled block per evaluator with its
 * score/status indicator and its own justification, rather than one dense
 * prose block (R4 AC-3, AC-8).
 */
function EvaluatorBreakdown({ breakdown }: { breakdown: EvaluatorScore[] }) {
    return (
        <SpaceBetween direction="vertical" size="m">
            {breakdown.map((ev, index) => (
                <div key={`${ev.evaluatorType}-${index}`}>
                    <SpaceBetween direction="horizontal" size="xs">
                        <Box fontWeight="bold" color="text-status-info">
                            {evaluatorLabel(ev.evaluatorType)}
                        </Box>
                        <ScoreIndicator status={ev.status} score={ev.score} />
                    </SpaceBetween>
                    <Box fontSize="body-s" color="text-body-secondary">
                        {ev.reason ? (
                            <pre
                                style={{
                                    margin: 0,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    fontFamily: "inherit",
                                    fontSize: "12px",
                                }}
                            >
                                {ev.reason}
                            </pre>
                        ) : (
                            "-"
                        )}
                    </Box>
                </div>
            ))}
        </SpaceBetween>
    );
}

/**
 * Compact inline cell for long text (Input / Expected Output). Wraps and clamps
 * with a max-height scroll box so long values stay readable inline without
 * blowing out row height. Full text remains available in the expandable detail.
 */
function ClampedText({ text }: { text?: string }) {
    if (!text) return <Box color="text-status-inactive">-</Box>;
    return (
        <Box fontSize="body-s">
            <div
                style={{
                    maxHeight: "6em",
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {text}
            </div>
        </Box>
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
 * Fallback renderer for older runs that only carry the combined reason string.
 * Parses the format: [EvaluatorType1] reason1\n[EvaluatorType2] reason2 into a
 * structured per-evaluator layout. Used ONLY when evaluatorBreakdown is absent.
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
            parts[parts.length - 1].text +=
                (parts[parts.length - 1].text ? " " : "") + trimmedLine;
        } else {
            // No evaluator prefix, add as generic entry
            parts.push({ evaluator: "", text: trimmedLine });
        }
    }

    // If no evaluator prefixes found, just show the raw text
    if (parts.length === 0 || (parts.length === 1 && !parts[0].evaluator)) {
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
                        <Box
                            fontWeight="bold"
                            color="text-status-info"
                            fontSize="body-s"
                        >
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
