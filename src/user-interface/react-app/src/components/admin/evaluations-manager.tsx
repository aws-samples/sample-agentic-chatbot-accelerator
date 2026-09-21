// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
    Box,
    Button,
    CollectionPreferences,
    Container,
    Header,
    Pagination,
    PropertyFilter,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { generateClient } from "aws-amplify/api";
import { AppContext } from "../../common/app-context";
import { useEvaluationRunWatcher } from "../../common/hooks/use-evaluation-run-watcher";
import { Evaluator } from "../../common/types";
import { Utils } from "../../common/utils";
import { deleteEvaluator as deleteEvaluatorMutation, startEvaluatorRun as startEvaluatorRunMutation } from "../../graphql/mutations";
import { listEvaluators as listEvaluatorsQuery } from "../../graphql/queries";
import DeleteEvaluatorModal from "./evaluations/delete-evaluator-modal";
import ViewEvaluatorModal from "./evaluations/view-evaluator-modal";
import RunHistoryModal from "./evaluations/run-history-modal";

const IN_FLIGHT_RUN_STATUSES = ["Running", "Queued"];

export interface EvaluationsManagerProps {
    readonly toolsOpen: boolean;
}

interface InFlightRun {
    readonly evaluatorId: string;
    readonly runId: string;
}

const hasInFlightRun = (evaluator: Evaluator): boolean =>
    IN_FLIGHT_RUN_STATUSES.includes(evaluator.lastRunStatus ?? "");

/**
 * Merge the in-flight runs a list response shows into the already tracked ones.
 *
 * `listEvaluators` answers with the complete set or, when the scan fails, an empty
 * array — so an empty list is no evidence that a tracked run ended: FR5, FR9.
 */
function reconcileInFlightRuns(tracked: InFlightRun[], evaluators: Evaluator[]): InFlightRun[] {
    const next = new Map(tracked.map(run => [run.evaluatorId, run]));

    if (evaluators.length > 0) {
        const listed = new Set(evaluators.map(e => e.evaluatorId));
        for (const run of tracked) {
            if (!listed.has(run.evaluatorId)) next.delete(run.evaluatorId);
        }
    }

    for (const evaluator of evaluators) {
        const isInFlight = hasInFlightRun(evaluator);
        if (isInFlight && evaluator.lastRunId) {
            next.set(evaluator.evaluatorId, {
                evaluatorId: evaluator.evaluatorId,
                runId: evaluator.lastRunId,
            });
        } else if (!isInFlight) {
            next.delete(evaluator.evaluatorId);
        }
    }

    const merged = [...next.values()];
    const unchanged =
        merged.length === tracked.length &&
        merged.every(
            (run, i) =>
                run.evaluatorId === tracked[i].evaluatorId && run.runId === tracked[i].runId
        );
    return unchanged ? tracked : merged;
}

/**
 * Re-point the selection at the rendered rows, dropping selections those rows no longer hold.
 *
 * Derived from the rows rather than from a list response, so a response the rows refused
 * cannot leave the action bar acting on a row that is no longer displayed: FR5.
 */
function reselect(selected: Evaluator[], evaluators: Evaluator[]): Evaluator[] {
    const next = selected
        .map(item => evaluators.find(e => e.evaluatorId === item.evaluatorId))
        .filter((e): e is Evaluator => e !== undefined);

    const unchanged =
        next.length === selected.length && next.every((e, i) => e === selected[i]);
    return unchanged ? selected : next;
}

interface EvaluationRunWatcherProps {
    readonly evaluatorId: string;
    readonly runId: string;
    readonly onRefetch: () => void | Promise<void>;
}

function EvaluationRunWatcher(props: EvaluationRunWatcherProps) {
    useEvaluationRunWatcher({
        evaluatorId: props.evaluatorId,
        runIds: [props.runId],
        onRefetch: props.onRefetch,
    });

    return null;
}


export default function EvaluationsManager(props: EvaluationsManagerProps) {
    const appContext = useContext(AppContext);
    const navigate = useNavigate();

    // States
    const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
    const [selectedItems, setSelectedItems] = useState<Evaluator[]>([]);
    const [preferences, setPreferences] = useState({ pageSize: 20 });
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    /** Runs still in flight, derived from the fetched evaluator list — no persisted client state. */
    const [trackedRuns, setTrackedRuns] = useState<InFlightRun[]>([]);

    const apiClient = useMemo(() => generateClient(), []);
    // a watcher refetch can resolve after unmount
    const isMounted = useRef(true);
    const hasLoaded = useRef(false);
    // bumped per read and per local write; only the newest generation may be applied: FR5
    const generation = useRef(0);

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    const fetchEvaluators = useCallback(async () => {
        if (!appContext) return;

        const readGeneration = ++generation.current;

        try {
            setIsLoading(!hasLoaded.current);
            const result = await apiClient.graphql({ query: listEvaluatorsQuery });
            if (!isMounted.current || readGeneration !== generation.current) return;

            const data = result.data?.listEvaluators || [];
            // Map GraphQL response to Evaluator type
            const fetched: Evaluator[] = data.map((item: any) => ({
                evaluatorId: item.evaluatorId,
                name: item.name,
                description: item.description,
                evaluatorType: item.evaluatorType,
                customRubric: item.customRubric,
                agentRuntimeName: item.agentRuntimeName,
                qualifier: item.qualifier,
                modelId: item.modelId,
                passThreshold: item.passThreshold,
                repeatCount: item.repeatCount,
                testCasesS3Path: item.testCasesS3Path,
                testCasesCount: item.testCasesCount,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                lastRunId: item.lastRunId,
                lastRunStatus: item.lastRunStatus,
                lastRunCompletedUnits: item.lastRunCompletedUnits,
                lastRunTotalUnits: item.lastRunTotalUnits,
                lastRunPassedCases: item.lastRunPassedCases,
                lastRunFailedCases: item.lastRunFailedCases,
                lastRunAt: item.lastRunAt,
            }));

            // a failed scan answers `[]` too (`evaluation-resolver/index.py:130-132`), so an
            // empty response may not retire rows this table still shows in flight: FR5, FR9
            setEvaluators(prev =>
                fetched.length === 0 && prev.some(hasInFlightRun) ? prev : fetched
            );
            hasLoaded.current = true;
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        } finally {
            if (isMounted.current) setIsLoading(false);
        }
    }, [appContext, apiClient]);

    useEffect(() => {
        fetchEvaluators();
    }, [props.toolsOpen, fetchEvaluators]);

    useEffect(() => {
        setTrackedRuns(prev => reconcileInFlightRuns(prev, evaluators));
        setSelectedItems(prev => reselect(prev, evaluators));
    }, [evaluators]);

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await fetchEvaluators();
        } finally {
            if (isMounted.current) setIsRefreshing(false);
        }
    }, [fetchEvaluators]);

    const handleRunEvaluation = async () => {
        if (selectedItems.length !== 1) return;

        const evaluator = selectedItems[0];
        setIsRunning(true);

        try {
            const result = await apiClient.graphql({
                query: startEvaluatorRunMutation,
                variables: { evaluatorId: evaluator.evaluatorId }
            });

            const run = result.data?.startEvaluatorRun;
            if (!run) {
                console.error("startEvaluatorRun returned no run");
                return;
            }

            const updated = {
                lastRunId: run.runId,
                lastRunStatus: run.status,
                // seeded from the run so the cell reads "0/N completed" rather than
                // "0/0" until the first milestone write lands
                lastRunCompletedUnits: 0,
                lastRunTotalUnits: run.totalUnits ?? 0,
                lastRunPassedCases: 0,
                lastRunFailedCases: 0,
                lastRunAt: run.startedAt ?? undefined,
            };
            // the Running pointer is already written, so reads issued before it are stale: FR5
            generation.current += 1;
            setEvaluators(prev => prev.map(e =>
                e.evaluatorId === evaluator.evaluatorId ? { ...e, ...updated } : e
            ));
            setSelectedItems(prev => prev.map(e =>
                e.evaluatorId === evaluator.evaluatorId ? { ...e, ...updated } : e
            ));

            console.log(`Started run ${run.runId} for ${evaluator.name}`);
        } catch (error) {
            console.error("Failed to run evaluation:", error);
        } finally {
            setIsRunning(false);
        }
    };

    const handleViewResults = () => {
        if (selectedItems.length !== 1) return;

        const evaluator = selectedItems[0];
        if (!evaluator.lastRunId) return;

        navigate(
            `/evaluations/${encodeURIComponent(
                evaluator.evaluatorId,
            )}/runs/${encodeURIComponent(evaluator.lastRunId)}`,
        );
    };

    const handleDelete = async () => {
        if (selectedItems.length !== 1) return;

        const evaluator = selectedItems[0];
        setIsDeleting(true);

        try {
            await apiClient.graphql({
                query: deleteEvaluatorMutation,
                variables: { evaluatorId: evaluator.evaluatorId }
            });

            // Remove from local list
            generation.current += 1;
            setEvaluators(prev => prev.filter(e => e.evaluatorId !== evaluator.evaluatorId));
            // the one absence an empty list response cannot report: FR9
            setTrackedRuns(prev => prev.filter(r => r.evaluatorId !== evaluator.evaluatorId));
            setSelectedItems([]);
            setShowDeleteModal(false);
        } catch (error) {
            console.error("Failed to delete evaluator:", error);
        } finally {
            setIsDeleting(false);
        }
    };

    // Table Empty State
    const EmptyState = ({
        title,
        subtitle,
        action,
    }: {
        title: string;
        subtitle?: string;
        action: React.ReactNode;
    }) => {
        return (
            <Box textAlign="center" color="inherit">
                <Box variant="strong" textAlign="center" color="inherit">
                    {title}
                </Box>
                <Box variant="p" padding={{ bottom: "s" }} color="inherit">
                    {subtitle}
                </Box>
                {action}
            </Box>
        );
    };

    const FILTERING_PROPERTIES = [
        {
            key: "name",
            propertyLabel: "Name",
            groupValuesLabel: "Name values",
            operators: [":", "!:", "=", "!="],
        },
        {
            key: "evaluatorType",
            propertyLabel: "Type",
            groupValuesLabel: "Type values",
            operators: [":", "!:", "=", "!="],
        },
        {
            key: "lastRunStatus",
            propertyLabel: "Last Run Status",
            groupValuesLabel: "Status values",
            operators: [":", "!:", "=", "!="],
        },
        {
            key: "agentRuntimeName",
            propertyLabel: "Agent Runtime",
            groupValuesLabel: "Agent Runtime values",
            operators: [":", "!:", "=", "!="],
        },
    ];

    const {
        items,
        actions,
        collectionProps,
        propertyFilterProps,
        filteredItemsCount,
        paginationProps,
    } = useCollection(evaluators, {
        pagination: { pageSize: preferences.pageSize },
        selection: {},
        sorting: {
            defaultState: {
                sortingColumn: {
                    sortingField: "name",
                },
                isDescending: false,
            },
        },
        propertyFiltering: {
            filteringProperties: FILTERING_PROPERTIES,
            empty: (
                <EmptyState
                    title="No evaluators found"
                    subtitle="Create your first evaluator to start testing your agents"
                    action={
                        <Button onClick={() => navigate("/evaluations/create")}>
                            New Evaluator
                        </Button>
                    }
                />
            ),
            noMatch: (
                <EmptyState
                    title="No matches"
                    action={<Button onClick={() => actions.setFiltering("")}>Clear filter</Button>}
                />
            ),
        },
    });

    const getStatusType = (status?: string): "success" | "warning" | "error" | "loading" | "info" => {
        if (!status) return "info";
        const lowerStatus = status.toLowerCase();
        if (lowerStatus === "creating" || lowerStatus === "running" || lowerStatus.endsWith("ing")) return "loading";
        if (lowerStatus === "ready" || lowerStatus === "completed" || lowerStatus === "passed") return "success";
        if (lowerStatus === "failed") return "error";
        return "info";
    };

    return (
        <>
            {trackedRuns.map(run => (
                <EvaluationRunWatcher
                    key={run.evaluatorId}
                    evaluatorId={run.evaluatorId}
                    runId={run.runId}
                    onRefetch={fetchEvaluators}
                />
            ))}

            <Container header="Agent Evaluations">
                <Table
                    {...collectionProps}
                    items={items}
                    onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
                    selectedItems={selectedItems}
                    selectionType="single"
                    trackBy="evaluatorId"
                    loading={isLoading}
                    loadingText="Loading evaluators..."
                    stickyHeader={true}
                    resizableColumns
                    pagination={<Pagination {...paginationProps} />}
                    preferences={
                        <CollectionPreferences
                            onConfirm={({ detail }) =>
                                setPreferences({ pageSize: detail.pageSize ?? 20 })
                            }
                            title="Preferences"
                            confirmLabel="Confirm"
                            cancelLabel="Cancel"
                            preferences={preferences}
                            pageSizePreference={{
                                title: "Page size",
                                options: [
                                    { value: 10, label: "10" },
                                    { value: 20, label: "20" },
                                    { value: 50, label: "50" },
                                ],
                            }}
                        />
                    }
                    header={
                        <Header
                            description="Create and manage evaluators to systematically assess agent performance"
                            variant="awsui-h1-sticky"
                            actions={
                                <SpaceBetween direction="horizontal" size="l" alignItems="center">
                                    <Button
                                        iconName="add-plus"
                                        variant="inline-link"
                                        onClick={() => navigate("/evaluations/create")}
                                    >
                                        New Evaluator
                                    </Button>
                                    <Button
                                        iconName="refresh"
                                        variant="inline-link"
                                        onClick={handleRefresh}
                                        loading={isRefreshing}
                                    >
                                        Refresh
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].lastRunStatus === "Running" ||
                                            selectedItems[0].lastRunStatus === "Queued"
                                        }
                                        iconName="caret-right-filled"
                                        variant="inline-link"
                                        onClick={handleRunEvaluation}
                                        loading={isRunning}
                                    >
                                        Run Evaluation
                                    </Button>
                                    <Button
                                        disabled={selectedItems.length !== 1}
                                        iconName="zoom-in"
                                        variant="inline-link"
                                        onClick={() => setShowViewModal(true)}
                                    >
                                        View
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].lastRunStatus === "Running" ||
                                            selectedItems[0].lastRunStatus === "Queued"
                                        }
                                        iconName="edit"
                                        variant="inline-link"
                                        onClick={() => navigate(`/evaluations/edit/${encodeURIComponent(selectedItems[0].evaluatorId)}`)}
                                    >
                                        Edit
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            !selectedItems[0].lastRunId ||
                                            selectedItems[0].lastRunStatus === "Running" ||
                                            selectedItems[0].lastRunStatus === "Queued"
                                        }
                                        iconName="view-full"
                                        variant="inline-link"
                                        onClick={handleViewResults}
                                    >
                                        View Latest Results
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            !selectedItems[0].lastRunId
                                        }
                                        iconName="list-view"
                                        variant="inline-link"
                                        onClick={() => setShowHistoryModal(true)}
                                    >
                                        Run History
                                    </Button>
                                    <Button
                                        iconName="remove"
                                        variant="inline-link"
                                        disabled={selectedItems.length !== 1}
                                        onClick={() => setShowDeleteModal(true)}
                                    >
                                        Delete
                                    </Button>
                                </SpaceBetween>
                            }
                        />
                    }
                    filter={
                        <PropertyFilter
                            {...propertyFilterProps}
                            countText={`${filteredItemsCount} matches`}
                            filteringPlaceholder="Filter evaluators by property"
                            filteringAriaLabel="Filter evaluators"
                        />
                    }
                    columnDefinitions={[
                        {
                            id: "name",
                            header: "Name",
                            cell: (item) => item.name,
                            isRowHeader: true,
                            sortingField: "name",
                            width: 200,
                        },
                        {
                            id: "evaluatorType",
                            header: "Evaluator Types",
                            cell: (item) => {
                                // evaluatorType can be comma-separated for multiple types
                                const types = item.evaluatorType?.split(",").map((t: string) => t.trim()) || [];
                                // Format type names (remove "Evaluator" suffix for brevity)
                                const formatType = (t: string) => t.replace(/Evaluator$/, "");
                                if (types.length <= 2) {
                                    return types.map(formatType).join(", ");
                                }
                                return `${formatType(types[0])}, +${types.length - 1} more`;
                            },
                            sortingField: "evaluatorType",
                            width: 200,
                        },
                        {
                            id: "agentRuntime",
                            header: "Agent Runtime",
                            cell: (item) => item.agentRuntimeName || "-",
                            sortingField: "agentRuntimeName",
                            width: 180,
                        },
                        {
                            id: "status",
                            header: "Last Run",
                            cell: (item) => (
                                item.lastRunStatus ? (
                                    <StatusIndicator type={getStatusType(item.lastRunStatus)}>
                                        {item.lastRunStatus}
                                    </StatusIndicator>
                                ) : <span>Never run</span>
                            ),
                            sortingField: "lastRunStatus",
                            width: 120,
                        },
                        {
                            id: "results",
                            header: "Last Results",
                            // While the run is in flight the pass/fail counts are still 0 —
                            // they are written at finalize — so report units done instead of
                            // claiming "0/0 passed" for a run that has judged nothing yet.
                            cell: (item) =>
                                hasInFlightRun(item) ? (
                                    <span>
                                        {item.lastRunCompletedUnits || 0}/
                                        {item.lastRunTotalUnits || 0} completed
                                    </span>
                                ) : item.lastRunPassedCases !== undefined ||
                                  item.lastRunFailedCases !== undefined ? (
                                    <span>
                                        {item.lastRunPassedCases || 0}/
                                        {(item.lastRunPassedCases || 0) +
                                            (item.lastRunFailedCases || 0)}{" "}
                                        passed
                                    </span>
                                ) : (
                                    "-"
                                ),
                            width: 140,
                        },
                        {
                            id: "createdAt",
                            header: "Created",
                            cell: (item) => new Date(item.createdAt).toLocaleDateString(),
                            sortingField: "createdAt",
                            width: 100,
                        },
                    ]}
                />
            </Container>

            {showDeleteModal && selectedItems.length === 1 && (
                <DeleteEvaluatorModal
                    visible={showDeleteModal}
                    onDismiss={() => setShowDeleteModal(false)}
                    evaluator={selectedItems[0]}
                    onDelete={handleDelete}
                    isDeleting={isDeleting}
                />
            )}

            {showViewModal && selectedItems.length === 1 && (
                <ViewEvaluatorModal
                    visible={showViewModal}
                    onDismiss={() => setShowViewModal(false)}
                    evaluator={selectedItems[0]}
                />
            )}

            {showHistoryModal && selectedItems.length === 1 && (
                <RunHistoryModal
                    visible={showHistoryModal}
                    onDismiss={() => setShowHistoryModal(false)}
                    evaluator={selectedItems[0]}
                />
            )}
        </>
    );
}
