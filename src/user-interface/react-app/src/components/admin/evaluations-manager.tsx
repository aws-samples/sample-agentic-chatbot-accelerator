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
import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { generateClient } from "aws-amplify/api";
import { AppContext } from "../../common/app-context";
import { Evaluator, EvaluationSummary } from "../../common/types";
import { Utils } from "../../common/utils";
import { deleteEvaluator as deleteEvaluatorMutation, runEvaluation as runEvaluationMutation } from "../../graphql/mutations";
import { listEvaluators as listEvaluatorsQuery, getEvaluator as getEvaluatorQuery } from "../../graphql/queries";
import DeleteEvaluatorModal from "./evaluations/delete-evaluator-modal";
import ViewEvaluatorModal from "./evaluations/view-evaluator-modal";
import ViewResultsModal from "./evaluations/view-results-modal";

export interface EvaluationsManagerProps {
    readonly toolsOpen: boolean;
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
    const [showResultsModal, setShowResultsModal] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [evaluationResults, setEvaluationResults] = useState<EvaluationSummary | null>(null);
    const [pollingEvaluatorId, setPollingEvaluatorId] = useState<string | null>(null);

    const apiClient = generateClient();

    const fetchEvaluators = useCallback(async () => {
        if (!appContext) return;

        try {
            setIsLoading(true);
            const result = await apiClient.graphql({ query: listEvaluatorsQuery });
            const data = result.data?.listEvaluators || [];
            // Map GraphQL response to Evaluator type
            setEvaluators(data.map((item: any) => ({
                evaluatorId: item.evaluatorId,
                name: item.name,
                description: item.description,
                evaluatorType: item.evaluatorType,
                customRubric: item.customRubric,
                agentRuntimeName: item.agentRuntimeName,
                qualifier: item.qualifier,
                testCasesS3Path: item.testCasesS3Path,
                testCasesCount: item.testCasesCount,
                status: item.status,
                passedCases: item.passedCases,
                failedCases: item.failedCases,
                totalTimeMs: item.totalTimeMs,
                errorMessage: item.errorMessage,
                createdAt: item.createdAt,
                startedAt: item.startedAt,
                completedAt: item.completedAt,
            })));
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        } finally {
            setIsLoading(false);
        }
    }, [appContext, apiClient]);

    useEffect(() => {
        fetchEvaluators();
    }, [props.toolsOpen]);

    // Poll for status updates when an evaluation is running
    useEffect(() => {
        if (!pollingEvaluatorId) return;

        const pollInterval = setInterval(async () => {
            try {
                const result = await apiClient.graphql({
                    query: getEvaluatorQuery,
                    variables: { evaluatorId: pollingEvaluatorId }
                });

                const evalData = result.data?.getEvaluator;
                if (evalData) {
                    const updatedEvaluator = {
                        status: evalData.status,
                        passedCases: evalData.passedCases ?? undefined,
                        failedCases: evalData.failedCases ?? undefined,
                        totalTimeMs: evalData.totalTimeMs ?? undefined,
                        completedAt: evalData.completedAt ?? undefined,
                    };

                    // Update local state with latest data
                    setEvaluators(prev => prev.map(e =>
                        e.evaluatorId === pollingEvaluatorId
                            ? { ...e, ...updatedEvaluator }
                            : e
                    ));

                    // Also update selectedItems if this evaluator is selected
                    setSelectedItems(prev => prev.map(e =>
                        e.evaluatorId === pollingEvaluatorId
                            ? { ...e, ...updatedEvaluator }
                            : e
                    ));

                    // Stop polling when evaluation is no longer running
                    if (evalData.status !== "Running") {
                        setPollingEvaluatorId(null);
                    }
                }
            } catch (error) {
                console.error("Polling failed:", error);
            }
        }, 2000); // Poll every 2 seconds

        return () => clearInterval(pollInterval);
    }, [pollingEvaluatorId, apiClient]);

    const handleRunEvaluation = async () => {
        if (selectedItems.length !== 1) return;

        const evaluator = selectedItems[0];
        setIsRunning(true);

        try {
            await apiClient.graphql({
                query: runEvaluationMutation,
                variables: { evaluatorId: evaluator.evaluatorId }
            });

            // Update local state to show Running
            setEvaluators(prev => prev.map(e =>
                e.evaluatorId === evaluator.evaluatorId
                    ? { ...e, status: "Running" }
                    : e
            ));

            // Also update selectedItems to keep button disabled
            setSelectedItems(prev => prev.map(e =>
                e.evaluatorId === evaluator.evaluatorId
                    ? { ...e, status: "Running" }
                    : e
            ));

            // Start polling for status updates
            setPollingEvaluatorId(evaluator.evaluatorId);

            console.log(`Started evaluation for ${evaluator.name}`);
        } catch (error) {
            console.error("Failed to run evaluation:", error);
        } finally {
            setIsRunning(false);
        }
    };

    const handleViewResults = async () => {
        if (selectedItems.length !== 1) return;

        const evaluator = selectedItems[0];

        try {
            const result = await apiClient.graphql({
                query: getEvaluatorQuery,
                variables: { evaluatorId: evaluator.evaluatorId }
            });

            const evalData = result.data?.getEvaluator;
            if (evalData) {
                const evaluationSummary: EvaluationSummary = {
                    runId: evalData.evaluatorId,
                    evaluatorId: evalData.evaluatorId,
                    totalCases: (evalData.passedCases || 0) + (evalData.failedCases || 0),
                    passedCases: evalData.passedCases || 0,
                    totalTimeMs: evalData.totalTimeMs || 0,
                    status: evalData.status,
                    completedAt: evalData.completedAt || undefined,
                    results: (evalData.results || []).map((r: any) => ({
                        caseName: r.caseName,
                        score: r.score,
                        passed: r.passed,
                        reason: r.reason,
                        latencyMs: r.latencyMs,
                    })),
                };
                setEvaluationResults(evaluationSummary);
                setShowResultsModal(true);
            }
        } catch (error) {
            console.error("Failed to fetch results:", error);
        }
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
            setEvaluators(prev => prev.filter(e => e.evaluatorId !== evaluator.evaluatorId));
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
            key: "status",
            propertyLabel: "Status",
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
                                        onClick={fetchEvaluators}
                                    >
                                        Refresh
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status === "Running" ||
                                            selectedItems[0].status === "Completed"
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
                                            selectedItems[0].status === "Created" ||
                                            selectedItems[0].status === "Running"
                                        }
                                        iconName="view-full"
                                        variant="inline-link"
                                        onClick={handleViewResults}
                                    >
                                        View Results
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
                            header: "Status",
                            cell: (item) => (
                                <StatusIndicator type={getStatusType(item.status)}>
                                    {item.status}
                                </StatusIndicator>
                            ),
                            sortingField: "status",
                            width: 100,
                        },
                        {
                            id: "results",
                            header: "Results",
                            cell: (item) => (
                                item.passedCases !== undefined || item.failedCases !== undefined ? (
                                    <span>
                                        {item.passedCases || 0}/{(item.passedCases || 0) + (item.failedCases || 0)} passed
                                    </span>
                                ) : "-"
                            ),
                            width: 120,
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

            {showResultsModal && evaluationResults && (
                <ViewResultsModal
                    visible={showResultsModal}
                    onDismiss={() => {
                        setShowResultsModal(false);
                        setEvaluationResults(null);
                    }}
                    evaluator={selectedItems[0]}
                    results={evaluationResults}
                />
            )}
        </>
    );
}
