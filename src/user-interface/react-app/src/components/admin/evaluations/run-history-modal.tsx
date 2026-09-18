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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useEvaluationRunWatcher } from "../../../common/hooks/use-evaluation-run-watcher";
import { Evaluator, EvaluatorRun } from "../../../common/types";
import { Utils } from "../../../common/utils";
import { listEvaluatorRuns as listEvaluatorRunsQuery } from "../../../graphql/queries";
import { deleteEvaluatorRun as deleteEvaluatorRunMutation } from "../../../graphql/mutations";

interface RunHistoryModalProps {
    visible: boolean;
    onDismiss: () => void;
    evaluator: Evaluator;
}

const IN_FLIGHT_RUN_STATUSES = ["Running", "Queued"];

const isRunInFlight = (run: EvaluatorRun): boolean =>
    IN_FLIGHT_RUN_STATUSES.includes(run.status);

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
    const navigate = useNavigate();
    const [runs, setRuns] = useState<EvaluatorRun[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    // a watcher refetch can resolve after unmount, or after the modal is closed
    const isMounted = useRef(true);
    const hasLoaded = useRef(false);
    // bumped per read, per local write and on close; only the newest generation may be applied
    const generation = useRef(0);

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    const fetchRuns = useCallback(async () => {
        const readGeneration = ++generation.current;
        setIsLoading(!hasLoaded.current);
        try {
            const result = await apiClient.graphql({
                query: listEvaluatorRunsQuery,
                variables: { evaluatorId: evaluator.evaluatorId },
            });
            if (!isMounted.current || readGeneration !== generation.current) return;

            const fetched = (result.data?.listEvaluatorRuns || []) as EvaluatorRun[];
            // a failed query answers `[]` too (`evaluation-resolver/index.py:165-167`), so an
            // empty response may not retire a run this list still shows in flight: FR9
            setRuns((prev) =>
                fetched.length === 0 && prev.some(isRunInFlight) ? prev : fetched,
            );
            hasLoaded.current = true;
        } catch (error) {
            console.error(Utils.getErrorMessage(error));
        } finally {
            if (isMounted.current) setIsLoading(false);
        }
    }, [apiClient, evaluator.evaluatorId]);

    useEffect(() => {
        if (visible) {
            void fetchRuns();
            return;
        }
        // the session ends on close: a read still in flight may not apply, and the next
        // open loads from scratch rather than settling on the previous open's rows
        generation.current += 1;
        hasLoaded.current = false;
    }, [visible, fetchRuns]);

    /** In-flight runs from the fetched list — the modal's own data, no extra query. */
    const inFlightRunIds = useMemo(
        () => runs.filter(isRunInFlight).map((run) => run.runId),
        [runs],
    );

    useEvaluationRunWatcher({
        evaluatorId: visible ? evaluator.evaluatorId : null,
        runIds: inFlightRunIds,
        onRefetch: fetchRuns,
    });

    const openRunResults = (run: EvaluatorRun) => {
        navigate(
            `/evaluations/${encodeURIComponent(
                evaluator.evaluatorId,
            )}/runs/${encodeURIComponent(run.runId)}`,
        );
    };

    const deleteRun = async (run: EvaluatorRun) => {
        try {
            await apiClient.graphql({
                query: deleteEvaluatorRunMutation,
                variables: { evaluatorId: evaluator.evaluatorId, runId: run.runId },
            });
            generation.current += 1;
            setRuns((prev) => prev.filter((r) => r.runId !== run.runId));
        } catch (error) {
            console.error("Failed to delete run:", error);
        }
    };

    return (
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
                        id: "agentRuntimeName",
                        header: "Agent Runtime",
                        cell: (item) => item.agentRuntimeName || "-",
                        width: 180,
                    },
                    {
                        id: "qualifier",
                        header: "Endpoint",
                        cell: (item) => item.qualifier || "-",
                        width: 120,
                    },
                    {
                        id: "runtimeVersion",
                        header: "Version",
                        cell: (item) =>
                            item.runtimeVersion ? (
                                item.runtimeVersion
                            ) : (
                                <StatusIndicator type="info">
                                    unknown
                                </StatusIndicator>
                            ),
                        width: 110,
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
                                    disabled={isRunInFlight(item)}
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
    );
}
