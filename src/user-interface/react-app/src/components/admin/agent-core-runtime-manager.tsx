// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
    Badge,
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
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

import { generateClient } from "aws-amplify/api";
import { ArchitectureType, RuntimeSummary } from "../../API";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import {
    createAgentCoreRuntime as createAgentCoreRuntimeMut,
    deleteAgentRuntimeEndpoints as deleteAgentRuntimeEndpointsMut,
    deleteAgentRuntime as deleteAgentRuntimeMut,
    resetFavoriteRuntime as resetFavoriteRuntimeMut,
    tagAgentCoreRuntime as tagAgentCoreRuntimeMut,
    updateFavoriteRuntime as updateFavoriteRuntimeMut,
} from "../../graphql/mutations";
import {
    getDefaultRuntimeConfiguration as getDefaultRuntimeConfigurationQuery,
    getFavoriteRuntime as getFavoriteRuntimeQuery,
    getRuntimeConfigurationByVersion as getRuntimeConfigurationByVersionQuery,
    listAgentBundleVersions as listAgentBundleVersionsQuery,
    listAgentVersions as listAgentVersionsQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";
import DeleteAgentModal from "./agent-core/delete-agent-modal";
import RowActions, { RowActionId } from "./agent-core/row-actions";
import { isTransientStatus } from "./agent-core/runtime-status";
import RuntimeUpdateWatcher from "./agent-core/runtime-update-watcher";
import TagVersionModal from "./agent-core/tag-version-modal";
import ViewVersionModal, { VersionInfo } from "./agent-core/view-version-modal";

/**
 * How long an unresolved seed stays in the in-flight set before being dropped. Bounds a forged
 * or stale seed; server-reported transient rows are never bounded (ADR 0007).
 */
const SEED_TTL_MS = 60_000;

/** A client-side guess that an agent is in flight, pending confirmation from a read. */
interface InFlightSeed {
    readonly agentName: string;
    /** Status this client had already seen when it guessed; `null` when the row was absent. */
    readonly seenStatus: string | null;
    /** `Date.now()` past which the seed is discarded. */
    readonly expiresAt: number;
}

/** Seeds a read has neither contradicted nor outlived: still showing `seenStatus`, or still absent. */
function unresolvedSeeds(
    seeds: InFlightSeed[],
    fetched: RuntimeSummary[],
    now: number,
): InFlightSeed[] {
    return seeds.filter((seed) => {
        if (seed.expiresAt <= now) return false;
        const row = fetched.find((agent) => agent.agentName === seed.agentName);
        return row === undefined || row.status === seed.seenStatus;
    });
}

export interface AgentManagerProps {
    readonly toolsOpen: boolean;
}

export default function AgentCoreEndpointManager(_props: AgentManagerProps) {
    const appContext = useContext(AppContext);
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();

    // States
    const [agents, setAgents] = useState<RuntimeSummary[]>([]);
    const [seeds, setSeeds] = useState<InFlightSeed[]>([]);
    const [selectedItems, setSelectedItems] = useState<RuntimeSummary[]>([]);
    const [preferences, setPreferences] = useState({ pageSize: 20 });
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [showTagModal, setShowTagModal] = useState(false);
    const [availableVersions, setAvailableVersions] = useState<string[]>([]);
    const [isTagging, setIsTagging] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [viewVersions, setViewVersions] = useState<VersionInfo[]>([]);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showUpdateContainerModal, setShowUpdateContainerModal] = useState(false);
    const [isUpdatingContainer, setIsUpdatingContainer] = useState(false);
    const [showFavoriteModal, setShowFavoriteModal] = useState(false);
    const [availableEndpoints, setAvailableEndpoints] = useState<string[]>([]);
    const [isSettingFavorite, setIsSettingFavorite] = useState(false);
    const [favoriteRuntime, setFavoriteRuntime] = useState<{
        agentRuntimeId: string;
        endpointName: string;
    } | null>(null);

    // functions
    const apiClient = useMemo(() => generateClient(), []);
    // a watcher refetch can resolve after unmount
    const isMounted = useRef(true);
    const hasLoaded = useRef(false);
    // bumped per read and per local mutation; only the newest generation may be applied: FR10
    const generation = useRef(0);
    // shared by concurrent callers so M watchers issue one read: FR11
    const inFlightRead = useRef<Promise<void> | null>(null);
    // a read resolving a render behind still has to see the newest seeds: FR9
    const seedsRef = useRef<InFlightSeed[]>(seeds);
    // at most one consecutive empty read is distrusted, so the guard cannot become a fixed point: FR9
    const consecutiveEmptyReads = useRef(0);

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);

    /** Discard reads issued before a local mutation, including one already in flight: FR10 */
    const invalidateReads = useCallback(() => {
        generation.current += 1;
        inFlightRead.current = null;
    }, []);

    const replaceSeeds = useCallback((next: InFlightSeed[]) => {
        seedsRef.current = next;
        setSeeds(next);
    }, []);

    /** Record a locally-initiated operation so its row is watched before the status write lands. */
    const seedAgent = useCallback(
        (agentName: string, seenStatus: string | null): void => {
            if (!agentName) return;

            replaceSeeds([
                ...seedsRef.current.filter((seed) => seed.agentName !== agentName),
                { agentName, seenStatus, expiresAt: Date.now() + SEED_TTL_MS },
            ]);
        },
        [replaceSeeds],
    );

    /**
     * Names to watch: every agent the server reports as transient, plus unexpired seeds.
     * Recomputed from `agents` + `seeds` — never persisted.
     */
    const inFlightAgentNames = useMemo<string[]>(() => {
        const now = Date.now();
        const names = new Set(
            agents
                .filter((agent) => isTransientStatus(agent.status))
                .map((agent) => agent.agentName),
        );
        for (const seed of seeds) {
            if (seed.expiresAt > now) names.add(seed.agentName);
        }
        return [...names];
    }, [agents, seeds]);

    /**
     * Whether a destructive or mutating action must be withheld from this row: the server reports
     * a control-plane op, or a local one is still unconfirmed by a read. Gates controls only —
     * a seed never feeds a rendered status (ADR 0007): FR16
     */
    const isActionWithheld = useCallback(
        (agent: RuntimeSummary): boolean => {
            const now = Date.now();
            return (
                isTransientStatus(agent.status) ||
                seeds.some((seed) => seed.agentName === agent.agentName && seed.expiresAt > now)
            );
        },
        [seeds],
    );

    /**
     * Re-read the authoritative agent list. Single-flight: concurrent callers receive the
     * in-flight promise, and an answer from a superseded generation is dropped.
     */
    const fetchAgents = useCallback((): Promise<void> => {
        if (!appContext) return Promise.resolve();
        if (inFlightRead.current) return inFlightRead.current;

        const readGeneration = ++generation.current;
        setIsLoading(!hasLoaded.current);

        const read = (async () => {
            try {
                const result = await apiClient.graphql({ query: listRuntimeAgentsQuery });
                if (!isMounted.current || readGeneration !== generation.current) return;

                const fetched = result.data.listRuntimeAgents || [];
                const outstanding = unresolvedSeeds(seedsRef.current, fetched, Date.now());
                if (outstanding.length !== seedsRef.current.length) replaceSeeds(outstanding);

                consecutiveEmptyReads.current =
                    fetched.length === 0 ? consecutiveEmptyReads.current + 1 : 0;

                setAgents((prev) => {
                    // a throttled read is indistinguishable from an empty account, and `prev` is
                    // the only synchronously fresh view of what the server reports as transient: FR9
                    const tracked =
                        outstanding.length > 0 ||
                        prev.some((agent) => isTransientStatus(agent.status));
                    return fetched.length === 0 && tracked && consecutiveEmptyReads.current === 1
                        ? prev
                        : fetched;
                });
                hasLoaded.current = true;
            } catch (error) {
                console.log(Utils.getErrorMessage(error));
            } finally {
                if (isMounted.current) setIsLoading(false);
            }
        })().finally(() => {
            if (inFlightRead.current === read) inFlightRead.current = null;
        });

        inFlightRead.current = read;
        return read;
    }, [appContext, apiClient, replaceSeeds]);

    // Update selectedItems when agents data changes
    useEffect(() => {
        setSelectedItems((prev) => {
            const next = prev
                .map((selectedItem) =>
                    agents.find((agent) => agent.agentRuntimeId === selectedItem.agentRuntimeId),
                )
                .filter((item): item is RuntimeSummary => item !== undefined);

            const unchanged = next.length === prev.length && next.every((a, i) => a === prev[i]);
            return unchanged ? prev : next;
        });
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

    useEffect(() => {
        fetchAgents();
        fetchFavoriteRuntime();
    }, []);

    const handleSetFavorite = async (agent: RuntimeSummary) => {
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

    const handleCreateNewVersion = (agent: RuntimeSummary) => {
        navigate(`/agent-core/create?from=${encodeURIComponent(agent.agentName)}`);
    };

    // Start a session: mint a fresh session id and open the chat route with the
    // agent id as a query param. The chat pre-selects this agent and pins the
    // qualifier to DEFAULT (implied by not passing one). Mirrors the ?from= idiom.
    const handleStartSession = (agent: RuntimeSummary) => {
        navigate(`/${uuidv4()}?agentRuntimeId=${encodeURIComponent(agent.agentRuntimeId)}`);
    };

    // Update container: re-version the agent against the currently-deployed image
    // URI without touching its configuration. We fetch the current default config
    // and re-submit it unchanged through createAgentCoreRuntime; because the name
    // matches an existing runtime, the backend calls update_agent_runtime with the
    // Lambda's current CONTAINER_URI, minting a new version on the deployed image.
    // This does NOT rebuild from source (see ADR 0005) and does NOT open the wizard.
    const handleUpdateContainer = async (agent: RuntimeSummary) => {
        // Re-validate at confirm time: a background refresh can flip the row to a
        // transient status while the modal is open, and the state machines only publish
        // at the end, so a just-started op is visible as a seed long before a status: FR16
        if (isActionWithheld(agent)) {
            console.warn("Skipping update: runtime has a control-plane operation in flight.");
            return;
        }

        setIsUpdatingContainer(true);
        try {
            const configResult = await apiClient.graphql({
                query: getDefaultRuntimeConfigurationQuery,
                variables: { agentName: agent.agentName },
            });
            const configValue = configResult.data.getDefaultRuntimeConfiguration;

            await apiClient.graphql({
                query: createAgentCoreRuntimeMut,
                variables: {
                    agentName: agent.agentName,
                    configValue,
                    architectureType: (agent.architectureType ?? "SINGLE") as ArchitectureType,
                },
            });
            invalidateReads();

            setShowUpdateContainerModal(false);
            seedAgent(agent.agentName, agent.status);
            await fetchAgents();
        } catch (error) {
            console.error("Failed to update container:", error);
        } finally {
            setIsUpdatingContainer(false);
        }
    };

    // Central dispatch for the per-row `⋯` action menu. Modals below read
    // selectedItems[0], so pin the selection to the acted-on row before
    // delegating to the (agent-taking) handlers. start-session and
    // update-container land in T5/T6.
    const handleRowAction = (id: RowActionId, agent: RuntimeSummary) => {
        setSelectedItems([agent]);
        switch (id) {
            case "new-version":
                handleCreateNewVersion(agent);
                break;
            case "tag-version":
                handleTagVersion(agent);
                break;
            case "set-favorite":
                handleSetFavorite(agent);
                break;
            case "view":
                handleViewAgent(agent);
                break;
            case "delete":
                setShowDeleteModal(true);
                break;
            case "start-session":
                handleStartSession(agent);
                break;
            case "update-container":
                setShowUpdateContainerModal(true);
                break;
        }
    };

    // The wizard hands the new agent's name over in the URL; the row may not exist yet, so the
    // param is consumed once into a seed and the derived set takes over from there.
    useEffect(() => {
        const subscribeAgent = searchParams.get("subscribeAgent")?.trim();
        if (!subscribeAgent) return;

        setSearchParams({}, { replace: true });
        seedAgent(subscribeAgent, null);
        void fetchAgents();
    }, [searchParams, setSearchParams, seedAgent, fetchAgents]);

    const handleTagVersion = async (agent: RuntimeSummary) => {
        setShowTagModal(true);
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
                invalidateReads();
                setShowTagModal(false);
                await fetchAgents(); // Refresh the list
            } catch (error) {
                console.error("Failed to tag version:", error);
            } finally {
                setIsTagging(false);
            }
        }
    };

    const handleViewAgent = async (agent: RuntimeSummary) => {
        try {
            // Refresh agent data to get latest qualifiers
            await apiClient.graphql({ query: listRuntimeAgentsQuery });

            // List the full history of the agent's configuration bundle. Config
            // lives in bundles now, so a "version" is a bundle versionId; the
            // resolver annotates each with the qualifiers pointing at it and its
            // creation time, so the modal can list every historical version with
            // a meaningful label — not just the qualifier-mapped current ones.
            const result = await apiClient.graphql({
                query: listAgentBundleVersionsQuery,
                variables: { agentName: agent.agentName },
            });

            const versions = (result.data.listAgentBundleVersions || [])
                .filter((v): v is NonNullable<typeof v> => v !== null)
                .map((v) => ({
                    version: v.versionId,
                    qualifiers: (v.qualifiers ?? []).filter((q): q is string => q !== null),
                    createdAt: v.createdAt,
                    commitMessage: v.commitMessage,
                }));

            setViewVersions(versions);
            setShowViewModal(true);
        } catch (error) {
            console.error("Failed to fetch agent versions:", error);
        }
    };

    // Fetch a runtime configuration by agent name + version. Name is passed
    // explicitly (rather than read from the selection) so the View modal can
    // drill into arbitrary sub-agents, not just the selected row.
    const handleVersionSelect = async (agentName: string, version: string) => {
        const result = await apiClient.graphql({
            query: getRuntimeConfigurationByVersionQuery,
            variables: {
                agentName,
                agentVersion: version,
            },
        });
        return JSON.parse(result.data.getRuntimeConfigurationByVersion);
    };

    const handleDelete = async (deleteMode: "all" | "specific", selectedQualifiers?: string[]) => {
        // Re-validate at confirm time: a background fetchAgents() can flip the
        // selection to a transient status while the modal is open. Never fire a
        // delete against a runtime with a control-plane op in flight: FR16
        if (selectedItems.some(isActionWithheld)) {
            console.warn("Skipping delete: a selected runtime has an operation in flight.");
            return;
        }

        setIsDeleting(true);
        try {
            // Multi-select deletes entire agents (no endpoint picker); the
            // single-select flow keeps the "all" | "specific" endpoint choice.
            if (selectedItems.length > 1) {
                const favoriteResult = await apiClient.graphql({ query: getFavoriteRuntimeQuery });
                const currentFavorite = favoriteResult.data.getFavoriteRuntime;

                // Reset the favorite if any agent being deleted currently owns it.
                if (
                    currentFavorite &&
                    selectedItems.some((a) => a.agentRuntimeId === currentFavorite.agentRuntimeId)
                ) {
                    await apiClient.graphql({ query: resetFavoriteRuntimeMut });
                }

                // Fire whole-agent deletes in parallel, then refresh once.
                await Promise.all(
                    selectedItems.map((agent) =>
                        apiClient.graphql({
                            query: deleteAgentRuntimeMut,
                            variables: {
                                agentName: agent.agentName,
                                agentRuntimeId: agent.agentRuntimeId,
                            },
                        }),
                    ),
                );
                invalidateReads();

                setShowDeleteModal(false);
                selectedItems.forEach((agent) => seedAgent(agent.agentName, agent.status));
                await fetchAgents();
            } else if (selectedItems.length === 1) {
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
                    invalidateReads();

                    // Close modal immediately (same as specific deletion)
                    setShowDeleteModal(false);

                    seedAgent(agent.agentName, agent.status);
                    await fetchAgents();
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
                    invalidateReads();

                    setShowDeleteModal(false);

                    seedAgent(agent.agentName, agent.status);
                    await fetchAgents();
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
        {
            key: "architectureType",
            propertyLabel: "Architecture",
            groupValuesLabel: "Architecture values",
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
            {inFlightAgentNames.map((agentName) => (
                <RuntimeUpdateWatcher
                    key={agentName}
                    agentName={agentName}
                    onRefetch={fetchAgents}
                />
            ))}

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
                                        iconName="settings"
                                        variant="inline-link"
                                        onClick={() => navigate("/agent-core/mcp-servers")}
                                    >
                                        Manage MCPs
                                    </Button>
                                    <Button
                                        iconName="edit"
                                        variant="inline-link"
                                        onClick={() => navigate("/agent-core/skills")}
                                    >
                                        Manage Skills
                                    </Button>
                                    <Button
                                        iconName="remove"
                                        variant="inline-link"
                                        disabled={
                                            selectedItems.length === 0 ||
                                            selectedItems.some(isActionWithheld)
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
                            id: "architectureType",
                            header: "Architecture",
                            cell: (item) => item.architectureType || "Single",
                            sortingField: "architectureType",
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
                                // qualifierToVersion maps a qualifier name (DEFAULT,
                                // BACKUP, …) to the bundle versionId it points at. The
                                // versionId is an opaque UUID, so we surface the
                                // qualifier name as the primary label and keep only a
                                // short id prefix as a muted hint.
                                let qualifierToVersion: Record<string, string> = {};
                                try {
                                    qualifierToVersion = JSON.parse(item.qualifierToVersion || "{}");
                                } catch {
                                    qualifierToVersion = {};
                                }

                                const entries = Object.entries(qualifierToVersion).sort(
                                    ([a], [b]) =>
                                        a === "DEFAULT" ? -1 : b === "DEFAULT" ? 1 : a.localeCompare(b),
                                );

                                if (entries.length === 0) {
                                    return (
                                        <Box color="text-status-inactive" fontSize="body-s">
                                            —
                                        </Box>
                                    );
                                }

                                return (
                                    <SpaceBetween direction="vertical" size="xxs">
                                        {entries.map(([qualifier, version]) => {
                                            const isFavorite =
                                                favoriteRuntime?.agentRuntimeId ===
                                                    item.agentRuntimeId &&
                                                favoriteRuntime?.endpointName === qualifier;
                                            const shortId = String(version).slice(0, 8);
                                            return (
                                                <SpaceBetween
                                                    key={qualifier}
                                                    direction="horizontal"
                                                    size="xs"
                                                    alignItems="center"
                                                >
                                                    <Badge color={isFavorite ? "green" : "blue"}>
                                                        {isFavorite ? `★ ${qualifier}` : qualifier}
                                                    </Badge>
                                                    <Box
                                                        color="text-status-inactive"
                                                        fontSize="body-s"
                                                        display="inline"
                                                    >
                                                        {shortId}
                                                    </Box>
                                                </SpaceBetween>
                                            );
                                        })}
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
                                        isTransientStatus(item.status)
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
                        {
                            id: "actions",
                            header: "Actions",
                            cell: (item) => (
                                <RowActions
                                    item={item}
                                    onAction={handleRowAction}
                                    busy={isActionWithheld(item)}
                                />
                            ),
                            width: 100,
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
                    agentRuntimeId={selectedItems[0].agentRuntimeId}
                    versions={viewVersions}
                    agents={agents}
                    onVersionSelect={handleVersionSelect}
                />
            )}
            {showDeleteModal && selectedItems.length >= 1 && (
                <DeleteAgentModal
                    visible={showDeleteModal}
                    onDismiss={() => setShowDeleteModal(false)}
                    selectedItems={selectedItems}
                    onDelete={handleDelete}
                    isDeleting={isDeleting}
                />
            )}
            {showUpdateContainerModal && selectedItems.length === 1 && (
                <Modal
                    visible={showUpdateContainerModal}
                    onDismiss={() => setShowUpdateContainerModal(false)}
                    header="Update container"
                    footer={
                        <Box float="right">
                            <SpaceBetween direction="horizontal" size="xs">
                                <Button
                                    variant="link"
                                    onClick={() => setShowUpdateContainerModal(false)}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={() => handleUpdateContainer(selectedItems[0])}
                                    loading={isUpdatingContainer}
                                    disabled={isActionWithheld(selectedItems[0])}
                                >
                                    Update container
                                </Button>
                            </SpaceBetween>
                        </Box>
                    }
                >
                    <SpaceBetween size="m">
                        <Box>
                            This mints a new version of{" "}
                            <strong>{selectedItems[0].agentName}</strong> using the currently
                            deployed container image, keeping its configuration unchanged.
                        </Box>
                        <Box variant="small" color="text-status-inactive">
                            This does not rebuild from source. New source code is picked up only by a
                            redeploy; this action adopts an already-deployed image update on this
                            runtime.
                        </Box>
                    </SpaceBetween>
                </Modal>
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
