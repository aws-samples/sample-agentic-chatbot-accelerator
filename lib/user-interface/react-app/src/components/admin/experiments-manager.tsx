// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//
// -----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    CollectionPreferences,
    ColumnLayout,
    Container,
    Header,
    KeyValuePairs,
    Link,
    Pagination,
    Popover,
    SpaceBetween,
    StatusIndicator,
    Table,
    TableProps,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as mutations from "../../graphql/mutations";
import * as queries from "../../graphql/queries";

interface Experiment {
    experimentId: string;
    userId: string;
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    status: string;
    generatedCasesS3Url?: string;
    taskDescription?: string;
    context?: string;
    numCases?: number;
    numTopics?: number;
    modelId?: string;
    generatedCasesCount?: number;
    errorMessage?: string;
    batchJobId?: string;
}

// LocalStorage key for page size persistence
const PAGE_SIZE_STORAGE_KEY = 'experiments-page-size';
const DEFAULT_PAGE_SIZE = 100;

/**
 * Save page size to localStorage
 * @param size - The page size to save
 * Note: This function will be used in task 4 for pagination preferences
 */
const savePageSize = (size: number): void => {
    try {
        localStorage.setItem(PAGE_SIZE_STORAGE_KEY, size.toString());
    } catch (error) {
        // localStorage might be unavailable (private browsing, storage quota exceeded, etc.)
        console.warn('Failed to save page size to localStorage:', error);
    }
};

/**
 * Load page size from localStorage
 * @returns The saved page size, or default (100) if not found or invalid
 * Note: This function will be used in task 4 for pagination preferences
 */
const loadPageSize = (): number => {
    try {
        const saved = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
        if (saved) {
            const parsed = parseInt(saved, 10);
            // Validate that the parsed value is a valid page size option
            if (!isNaN(parsed) && parsed > 0) {
                return parsed;
            }
        }
    } catch (error) {
        // localStorage might be unavailable (private browsing, etc.)
        console.warn('Failed to load page size from localStorage:', error);
    }
    return DEFAULT_PAGE_SIZE;
};

/**
 * Details Tab Component
 * Displays all experiment fields in an organized, readable format
 * **Validates: Requirements 2.3**
 *
 * @param experiment - The experiment to display details for
 */
interface DetailsTabProps {
    experiment: Experiment | null;
}

function DetailsTab({ experiment }: DetailsTabProps) {
    const [presignedUrlLoading, setPresignedUrlLoading] = useState(false);
    const [presignedUrlError, setPresignedUrlError] = useState<string | null>(null);
    const apiClient = generateClient();

    const handleViewS3File = async () => {
        if (!experiment?.generatedCasesS3Url) return;

        setPresignedUrlLoading(true);
        setPresignedUrlError(null);
        try {
            const response: any = await apiClient.graphql({
                query: queries.getExperimentPresignedUrl,
                variables: {
                    s3Uri: experiment.generatedCasesS3Url,
                },
            });
            window.open(response.data.getExperimentPresignedUrl!, "_blank");
        } catch (err) {
            console.error("Error generating presigned URL:", err);
            setPresignedUrlError("Failed to generate presigned URL");
        } finally {
            setPresignedUrlLoading(false);
        }
    };

    if (!experiment) {
        return (
            <Box textAlign="center" padding="l">
                <StatusIndicator type="info">No experiment selected</StatusIndicator>
            </Box>
        );
    }

    // Helper to format values, handling null/undefined
    const formatValue = (value: any): string => {
        if (value === null || value === undefined) return "-";
        if (typeof value === "boolean") return value ? "Yes" : "No";
        if (typeof value === "number") return value.toString();
        if (typeof value === "string") return value || "-";
        return "-";
    };

    // Format dates using toLocaleString()
    const formatDate = (dateString: string | undefined): string => {
        if (!dateString) return "-";
        try {
            return new Date(dateString).toLocaleString();
        } catch {
            return dateString;
        }
    };

    return (
        <SpaceBetween size="l">
            <Container header={<Header variant="h3">Basic Information</Header>}>
                <ColumnLayout columns={2} variant="text-grid">
                    <KeyValuePairs
                        columns={1}
                        items={[
                            {
                                label: "Experiment ID",
                                value: formatValue(experiment.experimentId),
                            },
                            {
                                label: "Name",
                                value: formatValue(experiment.name),
                            },
                            {
                                label: "Description",
                                value: formatValue(experiment.description),
                            },
                            {
                                label: "Status",
                                value: formatValue(experiment.status),
                            },
                        ]}
                    />
                    <KeyValuePairs
                        columns={1}
                        items={[
                            {
                                label: "User ID",
                                value: formatValue(experiment.userId),
                            },
                            {
                                label: "Created At",
                                value: formatDate(experiment.createdAt),
                            },
                            {
                                label: "Updated At",
                                value: formatDate(experiment.updatedAt),
                            },
                        ]}
                    />
                </ColumnLayout>
            </Container>

            <Container header={<Header variant="h3">Configuration</Header>}>
                <ColumnLayout columns={2} variant="text-grid">
                    <KeyValuePairs
                        columns={1}
                        items={[
                            {
                                label: "Model ID",
                                value: formatValue(experiment.modelId),
                            },
                            {
                                label: "Batch Job ID",
                                value: formatValue(experiment.batchJobId),
                            },
                        ]}
                    />
                    <KeyValuePairs
                        columns={1}
                        items={[
                            {
                                label: "Number of Cases",
                                value: formatValue(experiment.numCases),
                            },
                            {
                                label: "Number of Topics",
                                value: formatValue(experiment.numTopics),
                            },
                            {
                                label: "Generated Cases Count",
                                value: formatValue(experiment.generatedCasesCount),
                            },
                        ]}
                    />
                </ColumnLayout>
            </Container>

            <Container header={<Header variant="h3">Task Details</Header>}>
                <KeyValuePairs
                    columns={1}
                    items={[
                        {
                            label: "Task Description",
                            value: formatValue(experiment.taskDescription),
                        },
                        {
                            label: "Context",
                            value: formatValue(experiment.context),
                        },
                    ]}
                />
            </Container>

            <Container header={<Header variant="h3">S3 Data</Header>}>
                <KeyValuePairs
                    columns={1}
                    items={[
                        {
                            label: "Generated Cases S3 URL",
                            value: experiment.generatedCasesS3Url ? (
                                presignedUrlLoading ? (
                                    <StatusIndicator type="loading">Loading...</StatusIndicator>
                                ) : (
                                    <Link
                                        href="#"
                                        onFollow={(e) => {
                                            e.preventDefault();
                                            handleViewS3File();
                                        }}
                                        external
                                    >
                                        {experiment.generatedCasesS3Url}
                                    </Link>
                                )
                            ) : "-",
                        },
                    ]}
                />
                {presignedUrlError && (
                    <Box padding={{ top: "s" }}>
                        <Alert type="error" dismissible onDismiss={() => setPresignedUrlError(null)}>
                            {presignedUrlError}
                        </Alert>
                    </Box>
                )}
            </Container>

            {experiment.errorMessage && (
                <Container header={<Header variant="h3">Error Information</Header>}>
                    <Alert type="error">
                        {experiment.errorMessage}
                    </Alert>
                </Container>
            )}
        </SpaceBetween>
    );
}

export default function ExperimentsManager() {
    const [experiments, setExperiments] = useState<Experiment[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedItems, setSelectedItems] = useState<Experiment[]>([]);
    const [currentPageIndex, setCurrentPageIndex] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const [sortingColumn, setSortingColumn] = useState<TableProps.SortingColumn<Experiment>>({
        sortingField: "createdAt",
    });
    const [sortingDescending, setSortingDescending] = useState(true);
    const [pageSize, setPageSize] = useState<number>(loadPageSize());

    const navigate = useNavigate();
    const apiClient = generateClient();

    useEffect(() => {
        loadExperiments();
    }, []);

    const loadExperiments = async () => {
        setLoading(true);
        setError(null);
        try {
            const result: any = await apiClient.graphql({
                query: queries.listExperiments,
            });
            const experimentsList = result.data.listExperiments || [];

            // Sort experiments by createdAt in descending order (newest first)
            const sortedExperiments = [...experimentsList].sort((a, b) => {
                const dateA = new Date(a.createdAt).getTime();
                const dateB = new Date(b.createdAt).getTime();
                return dateB - dateA; // Descending order
            });

            setExperiments(sortedExperiments);
        } catch (err) {
            console.error("Error loading experiments:", err);
            setError("Failed to load experiments");
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (selectedItems.length === 0) return;

        setLoading(true);
        try {
            await Promise.all(
                selectedItems.map((item) =>
                    apiClient.graphql({
                        query: mutations.deleteExperiment,
                        variables: { experimentId: item.experimentId },
                    }),
                ),
            );
            await loadExperiments();
            setSelectedItems([]);
        } catch (err) {
            console.error("Error deleting experiments:", err);
            setError("Failed to delete experiments");
        } finally {
            setLoading(false);
        }
    };

    // Helper function to truncate text with tooltip
    const truncateWithTooltip = (text: string | undefined, maxLength: number = 30) => {
        if (!text) return "-";
        if (text.length <= maxLength) return text;

        return (
            <Popover
                dismissButton={false}
                position="top"
                size="small"
                triggerType="custom"
                content={<Box variant="small">{text}</Box>}
            >
                <span style={{ cursor: "help" }}>
                    {text.substring(0, maxLength)}...
                </span>
            </Popover>
        );
    };

    // Helper function to copy text to clipboard
    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (err) {
            console.error("Failed to copy to clipboard:", err);
        }
    };

    const columnDefinitions: TableProps.ColumnDefinition<Experiment>[] = [
        {
            id: "experimentId",
            header: "Experiment ID",
            cell: (item) => truncateWithTooltip(item.experimentId, 20),
            sortingField: "experimentId",
        },
        {
            id: "name",
            header: "Name",
            cell: (item) => item.name,
            sortingField: "name",
        },
        {
            id: "description",
            header: "Description",
            cell: (item) => truncateWithTooltip(item.description, 40),
        },
        {
            id: "status",
            header: "Status",
            cell: (item) => {
                const statusType =
                    item.status === "COMPLETED" ? "success" :
                    item.status === "RUNNING" ? "in-progress" :
                    item.status === "FAILED" ? "error" :
                    "pending";
                return <StatusIndicator type={statusType}>{item.status}</StatusIndicator>;
            },
        },
        {
            id: "modelId",
            header: "Model ID",
            cell: (item) => truncateWithTooltip(item.modelId, 25),
        },
        {
            id: "generatedCasesS3Url",
            header: "Generated Cases URL",
            cell: (item) => {
                if (!item.generatedCasesS3Url) return "-";

                return (
                    <SpaceBetween direction="horizontal" size="xs">
                        {truncateWithTooltip(item.generatedCasesS3Url, 30)}
                        <Button
                            variant="inline-icon"
                            iconName="copy"
                            ariaLabel="Copy S3 URL"
                            onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(item.generatedCasesS3Url!);
                            }}
                        />
                    </SpaceBetween>
                );
            },
        },
        {
            id: "createdAt",
            header: "Created",
            cell: (item) => new Date(item.createdAt).toLocaleString(),
            sortingField: "createdAt",
        },
        {
            id: "updatedAt",
            header: "Updated",
            cell: (item) => new Date(item.updatedAt).toLocaleString(),
            sortingField: "updatedAt",
        },
    ];

    const paginatedItems = experiments.slice(
        (currentPageIndex - 1) * pageSize,
        currentPageIndex * pageSize,
    );

    const handleSortingChange = (detail: TableProps.SortingState<Experiment>) => {
        setSortingColumn(detail.sortingColumn);
        setSortingDescending(detail.isDescending ?? false);

        // Sort the experiments array
        const sorted = [...experiments].sort((a, b) => {
            const field = detail.sortingColumn.sortingField as keyof Experiment;
            const aValue = a[field];
            const bValue = b[field];

            // Handle undefined/null values
            if (aValue === undefined || aValue === null) return 1;
            if (bValue === undefined || bValue === null) return -1;

            // Compare values
            let comparison = 0;
            if (typeof aValue === 'string' && typeof bValue === 'string') {
                comparison = aValue.localeCompare(bValue);
            } else if (field === 'createdAt' || field === 'updatedAt') {
                const dateA = new Date(aValue as string).getTime();
                const dateB = new Date(bValue as string).getTime();
                comparison = dateA - dateB;
            } else {
                comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
            }

            return detail.isDescending ? -comparison : comparison;
        });

        setExperiments(sorted);
        setCurrentPageIndex(1); // Reset to first page when sorting changes
    };

    const handlePageSizeChange = (newPageSize: number) => {
        setPageSize(newPageSize);
        savePageSize(newPageSize);
        setCurrentPageIndex(1); // Reset to first page when page size changes
    };

    return (
        <SpaceBetween size="l">
            {error && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>
                    {error}
                </Alert>
            )}
            <Table
                columnDefinitions={columnDefinitions}
                items={paginatedItems}
                loading={loading}
                loadingText="Loading experiments"
                selectionType="multi"
                selectedItems={selectedItems}
                onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
                sortingColumn={sortingColumn}
                sortingDescending={sortingDescending}
                onSortingChange={({ detail }) => handleSortingChange(detail)}
                empty={
                    <Box textAlign="center" color="inherit">
                        <b>No experiments</b>
                        <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                            No experiments to display.
                        </Box>
                        <Button onClick={() => navigate("/experiments/create")}>
                            Create experiment
                        </Button>
                    </Box>
                }
                header={
                    <Header
                        variant="h2"
                        counter={`(${experiments.length})`}
                        actions={
                            <SpaceBetween direction="horizontal" size="xs">
                                <Button onClick={handleDelete} disabled={selectedItems.length === 0}>
                                    Delete
                                </Button>
                                <Button variant="primary" onClick={() => navigate("/experiments/create")}>
                                    Create Experiment
                                </Button>
                            </SpaceBetween>
                        }
                    >
                        Experiments Generated
                    </Header>
                }
                pagination={
                    <Pagination
                        currentPageIndex={currentPageIndex}
                        onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                        pagesCount={Math.ceil(experiments.length / pageSize)}
                    />
                }
                preferences={
                    <CollectionPreferences
                        title="Preferences"
                        confirmLabel="Confirm"
                        cancelLabel="Cancel"
                        preferences={{
                            pageSize: pageSize,
                        }}
                        pageSizePreference={{
                            title: "Page size",
                            options: [
                                { value: 10, label: "10 experiments" },
                                { value: 25, label: "25 experiments" },
                                { value: 50, label: "50 experiments" },
                                { value: 100, label: "100 experiments" },
                                { value: 200, label: "200 experiments" },
                            ],
                        }}
                        onConfirm={({ detail }) => {
                            if (detail.pageSize !== undefined) {
                                handlePageSizeChange(detail.pageSize);
                            }
                        }}
                    />
                }
            />

            {/* Show details when exactly one experiment is selected */}
            {selectedItems.length === 1 && (
                <DetailsTab experiment={selectedItems[0]} />
            )}
        </SpaceBetween>
    );
}
