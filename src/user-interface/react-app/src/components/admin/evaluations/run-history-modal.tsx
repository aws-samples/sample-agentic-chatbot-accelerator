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
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Evaluator, EvaluationSummary, EvaluatorRun } from "../../../common/types";
import { Utils } from "../../../common/utils";
import {
    listEvaluatorRuns as listEvaluatorRunsQuery,
    getEvaluatorRun as getEvaluatorRunQuery,
} from "../../../graphql/queries";
import { deleteEvaluatorRun as deleteEvaluatorRunMutation } from "../../../graphql/mutations";
import ViewResultsModal from "./view-results-modal";

interface RunHistoryModalProps {
    visible: boolean;
    onDismiss: () => void;
    evaluator: Evaluator;
}

const getStatusType = (
    status?: string,
): "success" | "warning" | "error" | "loading" | "info" => {
    if (!status) return "info";
    const s = status.toLowerCase();
    if (s === "running" || s === "queued") return "loading";
    if (s === "completed") return "success";
    if (s === "failed") return "error";
    return "info";
};

const formatDuration = (ms?: number): string => {
    if (!ms) return "-";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
};

export default function RunHistoryModal({
    visible,
    onDismiss,
    evaluator,
}: RunHistoryModalProps) {
    const apiClient = useMemo(() => generateClient(), []);
    const [runs, setRuns] = useState<EvaluatorRun[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedResults, setSelectedResults] = useState<EvaluationSummary | null>(null);

    const fetchRuns = useCallback(async () => {
        setIsLoading(true);
        try {
            const result = await apiClient.graphql({
                query: listEvaluatorRunsQuery,
                variables: { evaluatorId: evaluator.evaluatorId },
            });
            setRuns((result.data?.listEvaluatorRuns || []) as EvaluatorRun[]);
        } catch (error) {
            console.error(Utils.getErrorMessage(error));
        } finally {
            setIsLoading(false);
        }
    }, [apiClient, evaluator.evaluatorId]);

    useEffect(() => {
        if (visible) fetchRuns();
    }, [visible, fetchRuns]);

    const openRunResults = async (run: EvaluatorRun) => {
        try {
            const result = await apiClient.graphql({
                query: getEvaluatorRunQuery,
                variables: { evaluatorId: evaluator.evaluatorId, runId: run.runId },
            });
            const runData = result.data?.getEvaluatorRun;
            if (runData) {
                setSelectedResults({
                    runId: runData.runId,
                    evaluatorId: runData.evaluatorId,
                    totalCases:
                        runData.totalCases ||
                        (runData.passedCases || 0) + (runData.failedCases || 0),
                    passedCases: runData.passedCases || 0,
                    totalTimeMs: runData.totalTimeMs || 0,
                    status: runData.status,
                    completedAt: runData.completedAt || undefined,
                    results: (runData.results || []).map((r: any) => ({
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
                    })),
                });
            }
        } catch (error) {
            console.error("Failed to load run results:", error);
        }
    };

    const deleteRun = async (run: EvaluatorRun) => {
        try {
            await apiClient.graphql({
                query: deleteEvaluatorRunMutation,
                variables: { evaluatorId: evaluator.evaluatorId, runId: run.runId },
            });
            setRuns((prev) => prev.filter((r) => r.runId !== run.runId));
        } catch (error) {
            console.error("Failed to delete run:", error);
        }
    };

    return (
        <>
            <Modal
                visible={visible}
                onDismiss={onDismiss}
                header={`Run History: ${evaluator.name}`}
                size="large"
                footer={
                    <Box float="right">
                        <Button variant="primary" onClick={onDismiss}>
                            Close
                        </Button>
                    </Box>
                }
            >
                <Table
                    items={runs}
                    loading={isLoading}
                    loadingText="Loading runs..."
                    variant="embedded"
                    stripedRows
                    empty={
                        <Box textAlign="center" color="inherit">
                            <b>No runs yet</b>
                            <Box variant="p" color="inherit">
                                Run this evaluator to see its history here.
                            </Box>
                        </Box>
                    }
                    columnDefinitions={[
                        {
                            id: "startedAt",
                            header: "Started",
                            cell: (item) =>
                                item.startedAt
                                    ? new Date(item.startedAt).toLocaleString()
                                    : "-",
                            width: 200,
                        },
                        {
                            id: "status",
                            header: "Status",
                            cell: (item) => (
                                <StatusIndicator type={getStatusType(item.status)}>
                                    {item.status}
                                </StatusIndicator>
                            ),
                            width: 120,
                        },
                        {
                            id: "results",
                            header: "Passed",
                            cell: (item) =>
                                `${item.passedCases || 0}/${
                                    item.totalCases ||
                                    (item.passedCases || 0) + (item.failedCases || 0)
                                }`,
                            width: 100,
                        },
                        {
                            id: "duration",
                            header: "Duration",
                            cell: (item) => formatDuration(item.totalTimeMs),
                            width: 100,
                        },
                        {
                            id: "actions",
                            header: "Actions",
                            cell: (item) => (
                                <SpaceBetween direction="horizontal" size="xs">
                                    <Button
                                        variant="inline-link"
                                        disabled={
                                            item.status === "Running" ||
                                            item.status === "Queued"
                                        }
                                        onClick={() => openRunResults(item)}
                                    >
                                        View Results
                                    </Button>
                                    <Button
                                        variant="inline-link"
                                        onClick={() => deleteRun(item)}
                                    >
                                        Delete
                                    </Button>
                                </SpaceBetween>
                            ),
                        },
                    ]}
                />
            </Modal>

            {selectedResults && (
                <ViewResultsModal
                    visible={!!selectedResults}
                    onDismiss={() => setSelectedResults(null)}
                    evaluator={evaluator}
                    results={selectedResults}
                />
            )}
        </>
    );
}
