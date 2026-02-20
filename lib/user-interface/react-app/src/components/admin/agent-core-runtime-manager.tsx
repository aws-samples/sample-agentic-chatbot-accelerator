// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
    Box,
    Button,
    CollectionPreferences,
    Container,
    FormField,
    Header,
    Modal,
    Pagination,
    PropertyFilter,
    Select,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { generateClient } from "aws-amplify/api";
import { RuntimeSummary } from "../../API";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import {
    deleteAgentRuntimeEndpoints as deleteAgentRuntimeEndpointsMut,
    deleteAgentRuntime as deleteAgentRuntimeMut,
    resetFavoriteRuntime as resetFavoriteRuntimeMut,
    tagAgentCoreRuntime as tagAgentCoreRuntimeMut,
    updateFavoriteRuntime as updateFavoriteRuntimeMut,
} from "../../graphql/mutations";
import {
    getFavoriteRuntime as getFavoriteRuntimeQuery,
    getRuntimeConfigurationByVersion as getRuntimeConfigurationByVersionQuery,
    listAgentVersions as listAgentVersionsQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";
import { receiveUpdateNotification } from "../../graphql/subscriptions";
import DeleteAgentModal from "./agent-core/delete-agent-modal";
import TagVersionModal from "./agent-core/tag-version-modal";
import ViewVersionModal from "./agent-core/view-version-modal";

export interface AgentManagerProps {
    readonly toolsOpen: boolean;
}

export default function AgentCoreEndpointManager(props: AgentManagerProps) {
    const appContext = useContext(AppContext);
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();

    // States
    const [agents, setAgents] = useState<RuntimeSummary[]>([]);
    const [selectedItems, setSelectedItems] = useState<RuntimeSummary[]>([]);
    const [preferences, setPreferences] = useState({ pageSize: 20 });
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [showTagModal, setShowTagModal] = useState(false);
    const [availableVersions, setAvailableVersions] = useState<string[]>([]);
    const [isTagging, setIsTagging] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [viewVersions, setViewVersions] = useState<{ version: string; qualifiers: string[] }[]>(
        [],
    );
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showFavoriteModal, setShowFavoriteModal] = useState(false);
    const [availableEndpoints, setAvailableEndpoints] = useState<string[]>([]);
    const [isSettingFavorite, setIsSettingFavorite] = useState(false);
    const [favoriteRuntime, setFavoriteRuntime] = useState<{
        agentRuntimeId: string;
        endpointName: string;
    } | null>(null);

    // functions
    const apiClient = generateClient();

    const fetchAgents = useCallback(async () => {
        if (!appContext) return;

        try {
            setIsLoading(true);
            const result = await apiClient.graphql({ query: listRuntimeAgentsQuery });
            setAgents(result.data.listRuntimeAgents || []);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        } finally {
            setIsLoading(false);
        }
    }, [appContext, apiClient]);

    useEffect(() => {
        fetchAgents();
    }, [props.toolsOpen]);

    // Update selectedItems when agents data changes
    useEffect(() => {
        if (selectedItems.length > 0) {
            const updatedSelectedItems = selectedItems
                .map((selectedItem) =>
                    agents.find((agent) => agent.agentRuntimeId === selectedItem.agentRuntimeId),
                )
                .filter((item): item is RuntimeSummary => item !== undefined);

            setSelectedItems(updatedSelectedItems);
        }
    }, [agents]);

    const fetchFavoriteRuntime = useCallback(async () => {
        try {
            const result = await apiClient.graphql({ query: getFavoriteRuntimeQuery });
            const favorite = result.data.getFavoriteRuntime;
            setFavoriteRuntime(
                favorite
                    ? {
                          agentRuntimeId: favorite.agentRuntimeId,
                          endpointName: favorite.endpointName,
                      }
                    : null,
            );
        } catch (error) {
            console.log("No favorite runtime set or error fetching:", Utils.getErrorMessage(error));
            setFavoriteRuntime(null);
        }
    }, [apiClient]);

    // Update useEffect to fetch favorite runtime
    useEffect(() => {
        fetchAgents();
        fetchFavoriteRuntime();
    }, [props.toolsOpen]);

    const handleSetFavorite = async () => {
        if (selectedItems.length === 1) {
            const agent = selectedItems[0];
            const qualifierToVersion = JSON.parse(agent.qualifierToVersion);
            const endpoints = Object.keys(qualifierToVersion);

            if (endpoints.length === 1) {
                // Only one endpoint, set it as favorite directly
                await defineFavoriteRuntime(agent.agentRuntimeId, endpoints[0]);
            } else {
                // Multiple endpoints, show modal to select
                setAvailableEndpoints(endpoints);
                setShowFavoriteModal(true);
            }
        }
    };

    const defineFavoriteRuntime = async (agentRuntimeId: string, endpointName: string) => {
        setIsSettingFavorite(true);
        try {
            await apiClient.graphql({
                query: updateFavoriteRuntimeMut,
                variables: {
                    agentRuntimeId,
                    endpointName,
                },
            });
            await fetchFavoriteRuntime(); // Refresh favorite runtime
            console.log(`Set ${endpointName} as favorite for runtime ${agentRuntimeId}`);
        } catch (error) {
            console.error("Failed to set favorite runtime:", error);
        } finally {
            setIsSettingFavorite(false);
        }
    };

    const handleFavoriteSubmit = async (endpointName: string) => {
        if (selectedItems.length === 1) {
            await defineFavoriteRuntime(selectedItems[0].agentRuntimeId, endpointName);
            setShowFavoriteModal(false);
        }
    };

    const handleCreateNewVersion = () => {
        if (selectedItems.length === 1) {
            const agent = selectedItems[0];
            navigate(`/agent-core/create?from=${encodeURIComponent(agent.agentName)}`);
        }
    };

    // Handle subscription for newly created agents via URL params
    useEffect(() => {
        const subscribeAgent = searchParams.get("subscribeAgent");
        if (subscribeAgent) {
            // Clear the URL param
            setSearchParams({}, { replace: true });

            // Wait a bit for the agent to appear in the list
            const setupSubscription = async () => {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                await fetchAgents();

                const subscription = apiClient
                    .graphql({
                        query: receiveUpdateNotification,
                        variables: { agentName: subscribeAgent },
                    })
                    .subscribe({
                        next: (data) => {
                            if (
                                data.data?.receiveUpdateNotification?.agentName === subscribeAgent
                            ) {
                                fetchAgents(); // Refresh to show "Ready" status
                                subscription.unsubscribe();
                            }
                        },
                        error: (error) => {
                            console.error("Subscription error:", error);
                            subscription.unsubscribe();
                        },
                    });
            };

            setupSubscription();
        }
    }, [searchParams, setSearchParams, apiClient, fetchAgents]);

    const handleTagVersion = async () => {
        if (selectedItems.length === 1) {
            setShowTagModal(true);
            const agent = selectedItems[0];
            try {
                const result = await apiClient.graphql({
                    query: listAgentVersionsQuery,
                    variables: { agentRuntimeId: agent.agentRuntimeId },
                });
                setAvailableVersions(
                    (result.data.listAgentVersions || []).filter((v): v is string => v !== null),
                );
            } catch (error) {
                console.error("Failed to fetch agent versions:", error);
                setShowTagModal(false);
            }
        }
    };

    const handleTagSubmit = async (data: {
        version: string;
        tagName: string;
        description?: string;
    }) => {
        if (selectedItems.length === 1) {
            const agent = selectedItems[0];
            setIsTagging(true);
            try {
                await apiClient.graphql({
                    query: tagAgentCoreRuntimeMut,
                    variables: {
                        agentName: agent.agentName,
                        agentRuntimeId: agent.agentRuntimeId,
                        currentQualifierToVersion: agent.qualifierToVersion,
                        agentVersion: data.version,
                        qualifier: data.tagName,
                        description: data.description,
                    },
                });
                setShowTagModal(false);
                await fetchAgents(); // Refresh the list
            } catch (error) {
                console.error("Failed to tag version:", error);
            } finally {
                setIsTagging(false);
            }
        }
    };

    const handleViewAgent = async () => {
        if (selectedItems.length === 1) {
            const agent = selectedItems[0];
            try {
                // Refresh agent data to get latest qualifiers
                await apiClient.graphql({ query: listRuntimeAgentsQuery });

                // Get the updated agent data
                const updatedAgent = agents.find((a) => a.agentRuntimeId === agent.agentRuntimeId);
                if (!updatedAgent) return;

                const versionsResult = await apiClient.graphql({
                    query: listAgentVersionsQuery,
                    variables: { agentRuntimeId: agent.agentRuntimeId },
                });

                const qualifierToVersion = JSON.parse(updatedAgent.qualifierToVersion);
                const versionToQualifiers: Record<string, string[]> = {};

                // Group qualifiers by version
                Object.entries(qualifierToVersion).forEach(([qualifier, version]) => {
                    if (!versionToQualifiers[version as string]) {
                        versionToQualifiers[version as string] = [];
                    }
                    versionToQualifiers[version as string].push(qualifier);
                });

                const versions = (versionsResult.data.listAgentVersions || [])
                    .filter((v): v is string => v !== null)
                    .map((version) => ({
                        version,
                        qualifiers: versionToQualifiers[version] || [],
                    }));

                setViewVersions(versions);
                setShowViewModal(true);
            } catch (error) {
                console.error("Failed to fetch agent versions:", error);
            }
        }
    };

    const handleVersionSelect = async (version: string) => {
        if (selectedItems.length === 1) {
            const agent = selectedItems[0];
            const result = await apiClient.graphql({
                query: getRuntimeConfigurationByVersionQuery,
                variables: {
                    agentName: agent.agentName,
                    agentVersion: version,
                },
            });
            return JSON.parse(result.data.getRuntimeConfigurationByVersion);
        }
        throw new Error("No agent selected");
    };

    const handleDelete = async (deleteMode: "all" | "specific", selectedQualifiers?: string[]) => {
        setIsDeleting(true);
        try {
            if (selectedItems.length === 1) {
                const agent = selectedItems[0];

                const favoriteResult = await apiClient.graphql({ query: getFavoriteRuntimeQuery });
                const currentFavorite = favoriteResult.data.getFavoriteRuntime;

                let shouldResetFavorite = false;

                if (currentFavorite && currentFavorite.agentRuntimeId === agent.agentRuntimeId) {
                    if (deleteMode === "all") {
                        shouldResetFavorite = true;
                    } else if (
                        deleteMode === "specific" &&
                        selectedQualifiers?.includes(currentFavorite.endpointName)
                    ) {
                        shouldResetFavorite = true;
                    }
                }

                if (shouldResetFavorite) {
                    await apiClient.graphql({ query: resetFavoriteRuntimeMut });
                }

                if (deleteMode === "all") {
                    // Delete entire agent - now uses Step Function
                    await apiClient.graphql({
                        query: deleteAgentRuntimeMut,
                        variables: {
                            agentName: agent.agentName,
                            agentRuntimeId: agent.agentRuntimeId,
                        },
                    });

                    await new Promise((resolve) => setTimeout(resolve, 2000));

                    // Close modal immediately (same as specific deletion)
                    setShowDeleteModal(false);

                    // Fetch agents to show "Deleting" status
                    await fetchAgents();

                    // Subscribe to deletion notification
                    const subscription = apiClient
                        .graphql({
                            query: receiveUpdateNotification,
                            variables: { agentName: agent.agentName },
                        })
                        .subscribe({
                            next: (data) => {
                                if (
                                    data.data?.receiveUpdateNotification?.agentName ===
                                    agent.agentName
                                ) {
                                    fetchAgents(); // Refresh the list when deletion completes
                                    subscription.unsubscribe();
                                }
                            },
                            error: (error) => {
                                console.error("Subscription error:", error);
                                subscription.unsubscribe();
                            },
                        });
                } else if (deleteMode === "specific" && selectedQualifiers) {
                    // Delete specific endpoints
                    await apiClient.graphql({
                        query: deleteAgentRuntimeEndpointsMut,
                        variables: {
                            agentName: agent.agentName,
                            agentRuntimeId: agent.agentRuntimeId,
                            endpointNames: selectedQualifiers,
                        },
                    });

                    await new Promise((resolve) => setTimeout(resolve, 2000));

                    setShowDeleteModal(false);

                    await fetchAgents();

                    // Subscribe to deletion notification for refresh only
                    const subscription = apiClient
                        .graphql({
                            query: receiveUpdateNotification,
                            variables: { agentName: agent.agentName },
                        })
                        .subscribe({
                            next: (data) => {
                                if (
                                    data.data?.receiveUpdateNotification?.agentName ===
                                    agent.agentName
                                ) {
                                    fetchAgents(); // Just refresh the list
                                    subscription.unsubscribe();
                                }
                            },
                            error: (error) => {
                                console.error("Subscription error:", error);
                                subscription.unsubscribe();
                            },
                        });
                }
            }
        } catch (error) {
            console.error("Failed to delete:", error);
        } finally {
            setIsDeleting(false);
        }
    };

    // Table properties
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
            key: "agentName",
            propertyLabel: "Agent Name",
            groupValuesLabel: "Agent Name values",
            operators: [":", "!:", "=", "!="],
        },
        {
            key: "status",
            propertyLabel: "Status",
            groupValuesLabel: "Status values",
            operators: [":", "!:", "=", "!="],
        },
        {
            key: "agentRuntimeId",
            propertyLabel: "Runtime ID",
            groupValuesLabel: "Runtime ID values",
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
    } = useCollection(agents, {
        pagination: { pageSize: preferences.pageSize },
        selection: {},
        sorting: {
            defaultState: {
                sortingColumn: {
                    sortingField: "agentName",
                },
                isDescending: false,
            },
        },
        propertyFiltering: {
            filteringProperties: FILTERING_PROPERTIES,
            empty: (
                <EmptyState
                    title="No agents found"
                    action={
                        <Button onClick={() => navigate("/agent-core/create")}>Create Agent</Button>
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

    return (
        <>
            <Container header="AgentCore Runtime Manager">
                <Table
                    {...collectionProps}
                    items={items}
                    onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
                    selectedItems={selectedItems}
                    selectionType="multi"
                    trackBy="agentRuntimeId"
                    loading={isLoading}
                    loadingText="Loading agents..."
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
                            description="List of AgentCore Runtime agents"
                            variant="awsui-h1-sticky"
                            actions={
                                <SpaceBetween direction="horizontal" size="l" alignItems="center">
                                    <Button
                                        iconName="add-plus"
                                        variant="inline-link"
                                        onClick={() => navigate("/agent-core/create")}
                                    >
                                        New Agent
                                    </Button>
                                    <Button
                                        iconName="refresh"
                                        variant="inline-link"
                                        onClick={fetchAgents}
                                    >
                                        Refresh
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status.toLowerCase() !== "ready"
                                        }
                                        iconName="copy"
                                        variant="inline-link"
                                        onClick={handleCreateNewVersion}
                                    >
                                        New version
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status.toLowerCase() !== "ready"
                                        }
                                        iconName="flag"
                                        variant="inline-link"
                                        onClick={handleTagVersion}
                                    >
                                        Tag version
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status.toLowerCase() !== "ready"
                                        }
                                        iconName="star"
                                        variant="inline-link"
                                        onClick={handleSetFavorite}
                                        loading={isSettingFavorite}
                                    >
                                        Set as Favorite
                                    </Button>
                                    <Button
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status.toLowerCase() !== "ready"
                                        }
                                        iconName="zoom-in"
                                        variant="inline-link"
                                        onClick={handleViewAgent}
                                    >
                                        View
                                    </Button>
                                    <Button
                                        iconName="remove"
                                        variant="inline-link"
                                        disabled={
                                            selectedItems.length !== 1 ||
                                            selectedItems[0].status.toLowerCase() !== "ready"
                                        }
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
                            filteringPlaceholder="Filter agents by property"
                            filteringAriaLabel="Filter agents"
                        />
                    }
                    columnDefinitions={[
                        {
                            id: "agentName",
                            header: "Agent Name",
                            cell: (item) => (
                                <CopyToClipboard
                                    textToCopy={item.agentName}
                                    variant="inline"
                                    copySuccessText="Agent name copied"
                                    copyErrorText="Failed to copy agent name"
                                />
                            ),
                            isRowHeader: true,
                            sortingField: "agentName",
                            width: "auto",
                        },
                        {
                            id: "agentRuntimeId",
                            header: "Runtime ID",
                            cell: (item) => (
                                <CopyToClipboard
                                    textToCopy={item.agentRuntimeId}
                                    variant="inline"
                                    copySuccessText="Runtime ID copied"
                                    copyErrorText="Failed to copy runtime ID"
                                />
                            ),
                            sortingField: "agentRuntimeId",
                            width: "auto",
                        },
                        {
                            id: "numberOfVersion",
                            header: "Number of Versions",
                            cell: (item) => item.numberOfVersion,
                            sortingField: "numberOfVersion",
                        },
                        {
                            id: "qualifierToVersion",
                            header: "Qualifiers",
                            cell: (item) => {
                                const qualifierToVersion = JSON.parse(item.qualifierToVersion);
                                const versionToQualifiers: Record<string, string[]> = {};

                                // Group qualifiers by version
                                Object.entries(qualifierToVersion).forEach(
                                    ([qualifier, version]) => {
                                        if (!versionToQualifiers[version as string]) {
                                            versionToQualifiers[version as string] = [];
                                        }
                                        versionToQualifiers[version as string].push(qualifier);
                                    },
                                );

                                return (
                                    <SpaceBetween direction="vertical" size="xs">
                                        {Object.entries(versionToQualifiers)
                                            .sort(([a], [b]) => parseInt(b) - parseInt(a))
                                            .map(([version, qualifiers]) => (
                                                <Box key={version} fontSize="body-s">
                                                    <strong>v{version}:</strong>{" "}
                                                    {qualifiers.map((qualifier, index) => (
                                                        <span key={qualifier}>
                                                            {qualifier}
                                                            {favoriteRuntime?.agentRuntimeId ===
                                                                item.agentRuntimeId &&
                                                            favoriteRuntime?.endpointName ===
                                                                qualifier
                                                                ? " ⭐"
                                                                : ""}
                                                            {index < qualifiers.length - 1
                                                                ? ", "
                                                                : ""}
                                                        </span>
                                                    ))}
                                                </Box>
                                            ))}
                                    </SpaceBetween>
                                );
                            },
                            sortingField: "qualifierToVersion",
                            width: "auto",
                        },
                        {
                            id: "status",
                            header: "Status",
                            cell: (item) => (
                                <StatusIndicator
                                    type={
                                        item.status.toLowerCase().endsWith("ing")
                                            ? "loading"
                                            : item.status.toLowerCase() === "broken" ||
                                                item.status.toLocaleLowerCase().includes("failed")
                                              ? "error"
                                              : "success"
                                    }
                                >
                                    {item.status}
                                </StatusIndicator>
                            ),
                            sortingField: "status",
                            width: "auto",
                        },
                    ]}
                />
            </Container>
            {showTagModal && selectedItems.length === 1 && (
                <TagVersionModal
                    visible={showTagModal}
                    onDismiss={() => setShowTagModal(false)}
                    onSubmit={handleTagSubmit}
                    agentName={selectedItems[0].agentName}
                    availableVersions={availableVersions}
                    isLoading={isTagging}
                />
            )}
            {showViewModal && selectedItems.length === 1 && (
                <ViewVersionModal
                    visible={showViewModal}
                    onDismiss={() => setShowViewModal(false)}
                    agentName={selectedItems[0].agentName}
                    versions={viewVersions}
                    onVersionSelect={handleVersionSelect}
                />
            )}
            {showDeleteModal && selectedItems.length === 1 && (
                <DeleteAgentModal
                    visible={showDeleteModal}
                    onDismiss={() => setShowDeleteModal(false)}
                    selectedItem={selectedItems[0]}
                    onDelete={handleDelete}
                    isDeleting={isDeleting}
                />
            )}
            {showFavoriteModal && selectedItems.length === 1 && (
                <SetFavoriteModal
                    visible={showFavoriteModal}
                    onDismiss={() => setShowFavoriteModal(false)}
                    onSubmit={handleFavoriteSubmit}
                    agentName={selectedItems[0].agentName}
                    availableEndpoints={availableEndpoints}
                    isLoading={isSettingFavorite}
                />
            )}
        </>
    );
}

// Simple modal component for selecting endpoint
function SetFavoriteModal({
    visible,
    onDismiss,
    onSubmit,
    agentName,
    availableEndpoints,
    isLoading,
}: {
    visible: boolean;
    onDismiss: () => void;
    onSubmit: (endpointName: string) => void;
    agentName: string;
    availableEndpoints: string[];
    isLoading: boolean;
}) {
    const [selectedEndpoint, setSelectedEndpoint] = useState<string>("");

    const handleSubmit = () => {
        if (selectedEndpoint) {
            onSubmit(selectedEndpoint);
        }
    };

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header="Set as Favorite"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={onDismiss}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSubmit}
                            disabled={!selectedEndpoint}
                            loading={isLoading}
                        >
                            Set as Favorite
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                <Box>
                    Select which endpoint to set as favorite for agent <strong>{agentName}</strong>:
                </Box>
                <FormField label="Endpoint">
                    <Select
                        selectedOption={
                            selectedEndpoint
                                ? { label: selectedEndpoint, value: selectedEndpoint }
                                : null
                        }
                        onChange={({ detail }) =>
                            setSelectedEndpoint(detail.selectedOption?.value || "")
                        }
                        options={availableEndpoints.map((endpoint) => ({
                            label: endpoint,
                            value: endpoint,
                        }))}
                        placeholder="Select endpoint"
                    />
                </FormField>
            </SpaceBetween>
        </Modal>
    );
}
