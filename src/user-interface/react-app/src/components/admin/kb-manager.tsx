// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import { useCollection } from "@cloudscape-design/collection-hooks";
import {
    Alert,
    Box,
    Button,
    CollectionPreferences,
    Container,
    Flashbar,
    Header,
    Modal,
    Pagination,
    Select,
    SpaceBetween,
    Table,
    TextFilter,
} from "@cloudscape-design/components";
import { useCallback, useContext, useEffect, useState } from "react";

import { generateClient } from "aws-amplify/api";

import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";

import { KnowledgeBase, ResponseStatus, S3DataSource } from "../../API";
import { StorageHelper } from "../../common/helpers/storage-helper";
import {
    createKnowledgeBase as createKnowledgeBaseMut,
    deleteDataSource as deleteDataSourceMut,
    deleteKnowledgeBase as deleteKnowledgeBaseMut,
    syncKnowledgeBase as syncKnowledgeBaseMut,
} from "../../graphql/mutations";
import {
    checkOnSyncInProgress as checkOnSyncInProgressQuery,
    listDataSources as listDataSourcesQuery,
    listKnowledgeBases as listKnowledgeBasesQuery,
} from "../../graphql/queries";

import { DataSourceConfigurationManager } from "../admin/configure/data-source-config";
import { KbConfigurationManager } from "../admin/configure/kb-config";
import { DataSourceConfig, KbConfig } from "../admin/configure/types";
import KnowledgeBaseCreationWizard from "../wizard/kb-creation-wizard";
import { KnowledgeBaseCreationData } from "../wizard/types";
import { OperationStatus } from "./configure/types";

export interface KBManagerProps {
    readonly toolsOpen: boolean;
}

export default function KBManager(props: KBManagerProps) {
    const appContext = useContext(AppContext);

    // ---------------------------------------------------------------------------------- //
    //                      Component states
    // ---------------------------------------------------------------------------------- //
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
    const [tableLoadingText, setTableLoadingText] = useState<string>("");
    const [preferences, setPreferences] = useState({ pageSize: 20 });

    const [selectedItems, setSelectedItems] = useState<KnowledgeBase[]>([]);

    const resetKbConfigDialogValue: KbConfig = {
        visible: false,
        id: "",
        value: "",
    };
    const resetDsConfigDialogValue: DataSourceConfig = {
        ...resetKbConfigDialogValue,
        kbId: "",
    };
    const [kbConfigDialog, setKbConfigDialog] = useState<KbConfig>(resetKbConfigDialogValue);
    const [dsConfigDialog, setDsConfigDialog] =
        useState<DataSourceConfig>(resetDsConfigDialogValue);

    const [showDsModalDelete, setShowDsModalDelete] = useState<boolean>(false);
    const [dataSources, setDataSources] = useState<S3DataSource[]>([]);
    const [selectedDS, setSelectedDS] = useState<S3DataSource | null>(null);
    const [isLoadingDS, setIsLoadingDS] = useState<boolean>(false);
    const [delStatus, setDelStatus] = useState<OperationStatus | undefined>(undefined);

    const [showKbModalDelete, setShowKbModalDelete] = useState<boolean>(false);

    const [syncStatus, setSyncStatus] = useState<OperationStatus | undefined>(undefined);

    const [showKbCreationWizard, setShowKbCreationWizard] = useState(false);
    const [creationStatus, setCreationStatus] = useState<OperationStatus | undefined>(undefined);
    const [showKbCreationModal, setShowKbCreationModal] = useState<boolean>(false);

    // ---------------------------------------------------------------------------------- //

    const apiClient = generateClient();

    // ---------------------------------------------------------------------------------- //
    //                      Callback to load list of knowledge bases
    // ---------------------------------------------------------------------------------- //
    const fetchKnowledgeBases = useCallback(async () => {
        if (!appContext) return;

        try {
            setIsLoading(true);
            setTableLoadingText("Loading Knowledge Bases...");
            const result = await apiClient.graphql({ query: listKnowledgeBasesQuery });
            setKnowledgeBases(result.data!.listKnowledgeBases);
            setIsLoading(false);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        }
    }, [appContext]);

    useEffect(() => {
        if (kbConfigDialog.visible || dsConfigDialog.visible || showKbModalDelete) return;
        if (!appContext) return;

        const loadTable = async () => {
            setIsLoading(true);
            try {
                await fetchKnowledgeBases();
            } finally {
                setIsLoading(false);
            }
        };

        loadTable();
    }, [
        props.toolsOpen,
        kbConfigDialog.visible,
        dsConfigDialog.visible,
        showKbModalDelete,
        showKbCreationModal,
    ]);

    useEffect(() => {
        if (!appContext || selectedItems.length !== 1) return;

        setDsConfigDialog({
            ...dsConfigDialog,
            kbId: selectedItems[0].id,
        });
    }, [selectedItems]);
    // ---------------------------------------------------------------------------------- //

    // ---------------------------------------------------------------------------------- //
    //                          Required for removal of data sources
    // ---------------------------------------------------------------------------------- //
    const fetchDataSources = useCallback(async () => {
        if (!appContext || !dsConfigDialog.kbId) return;

        try {
            setIsLoadingDS(true);
            const result = await apiClient.graphql({
                query: listDataSourcesQuery,
                variables: {
                    kbId: dsConfigDialog.kbId,
                },
            });
            setDataSources(result.data!.listDataSources);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        } finally {
            setIsLoadingDS(false);
        }
    }, [appContext, dsConfigDialog.kbId]);

    useEffect(() => {
        fetchDataSources();
    }, [dsConfigDialog.kbId, fetchDataSources, showDsModalDelete]);

    const deleteSelectedDataSource = async () => {
        if (!appContext || !dsConfigDialog.kbId || selectedDS === null) return;

        try {
            setDelStatus("in-progress");
            await apiClient.graphql({
                query: deleteDataSourceMut,
                variables: {
                    kbId: dsConfigDialog.kbId,
                    dataSourceId: selectedDS.id,
                },
            });
            setDelStatus("success");
            setTimeout(() => {
                setSelectedDS(null);
                setShowDsModalDelete(false);
                setDelStatus(undefined);
            }, 1000);
        } catch (error) {
            console.error("Failed to delete DS");
            setDelStatus("failed");
            setSelectedDS(null);
        }
    };

    const resetDsDeletionState = () => {
        setShowDsModalDelete(false);
        setSelectedDS(null);
        setIsLoadingDS(false);
        setDelStatus(undefined);
    };

    const deleteDsModal = (
        <Modal
            onDismiss={() => resetDsDeletionState()}
            visible={showDsModalDelete}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        {" "}
                        <Button variant="link" onClick={() => resetDsDeletionState()}>
                            {"Cancel"}
                        </Button>
                        <Button variant="primary" onClick={deleteSelectedDataSource}>
                            {"OK"}
                        </Button>
                    </SpaceBetween>{" "}
                </Box>
            }
            header={`Select the data source that you want to remove`}
        >
            <SpaceBetween direction="vertical" size="m">
                {delStatus && (
                    <Flashbar
                        items={[
                            {
                                type: delStatus === "failed" ? "error" : "success",
                                content:
                                    delStatus === "failed"
                                        ? "Failed to remove the data source"
                                        : delStatus === "in-progress"
                                          ? `Deletion in progress...`
                                          : "Successful",
                                loading: delStatus === "in-progress",
                                id: `message-ds-${delStatus}`,
                            },
                        ]}
                    />
                )}
                <Select
                    data-locator="select-data-source"
                    placeholder="Select a Data Source"
                    loadingText="Loading Data Sources"
                    statusType={isLoadingDS ? "loading" : undefined}
                    filteringType="auto"
                    selectedOption={
                        selectedDS
                            ? { value: JSON.stringify(selectedDS), label: selectedDS.name }
                            : null
                    }
                    onChange={({ detail }) => {
                        if (!detail.selectedOption.value) return;
                        setSelectedDS(JSON.parse(detail.selectedOption.value) as S3DataSource);
                    }}
                    options={dataSources.map((ds) => ({
                        value: JSON.stringify(ds),
                        label: ds.name,
                    }))}
                ></Select>
            </SpaceBetween>{" "}
        </Modal>
    );

    const handleKbCreation = async (config: KnowledgeBaseCreationData) => {
        try {
            setShowKbCreationWizard(false);
            setShowKbCreationModal(true);
            setCreationStatus("in-progress");
            const apiClient = generateClient();
            await apiClient.graphql({
                query: createKnowledgeBaseMut,
                variables: {
                    kbName: config.name,
                    props: JSON.stringify({ ...config, name: undefined }),
                },
            });
            setCreationStatus("success");
            await fetchKnowledgeBases(); // Refresh the list
            setTimeout(() => {
                setCreationStatus(undefined);
                setShowKbCreationModal(false);
            }, 1000);
        } catch (error) {
            setCreationStatus("failed");
            console.error("Failed to create knowledge base:", error);
            setTimeout(() => {
                setCreationStatus(undefined);
                setShowKbCreationModal(false);
            }, 1000);
        }
    };

    // ---------------------------------------------------------------------------------- //

    // ---------------------------------------------------------------------------------- //
    //                          Required for removal of knowledge base
    // ---------------------------------------------------------------------------------- //
    const deleteSelectedKbs = async () => {
        if (!appContext) return;

        try {
            setDelStatus("in-progress");
            await Promise.all(
                selectedItems.map((s) =>
                    apiClient.graphql({
                        query: deleteKnowledgeBaseMut,
                        variables: { kbId: s.id },
                    }),
                ),
            );
            setDelStatus("success");

            setTimeout(() => {
                setSelectedItems([]);
                setShowKbModalDelete(false);
                setDelStatus(undefined);
            }, 1000);
        } catch (error) {
            console.error("Error deleting documents:", error);
            setDelStatus("failed");
            setSelectedItems([]);
        }
    };

    const deleteKbModal = (
        <Modal
            onDismiss={() => setShowKbModalDelete(false)}
            visible={showKbModalDelete}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        {" "}
                        <Button variant="link" onClick={() => setShowKbModalDelete(false)}>
                            {"Cancel"}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={deleteSelectedKbs}
                            disabled={delStatus !== undefined}
                        >
                            {"OK"}
                        </Button>
                    </SpaceBetween>{" "}
                </Box>
            }
            header={"Delete Knowledge Bases" + (selectedItems.length > 1 ? "s" : "")}
        >
            <SpaceBetween direction="vertical" size="m">
                {delStatus && (
                    <Flashbar
                        items={[
                            {
                                type: delStatus === "failed" ? "error" : "success",
                                content:
                                    delStatus === "failed"
                                        ? "Failed to remove a Knowledge Base"
                                        : delStatus === "in-progress"
                                          ? `Deletion in progress...`
                                          : "Successful",
                                loading: delStatus === "in-progress",
                                id: `message-kb-${delStatus}`,
                            },
                        ]}
                    />
                )}
                {`Do you want to delete ${
                    selectedItems.length == 1
                        ? `the Knowledge Base ${selectedItems[0].name} ?`
                        : `${selectedItems.length} Knowledge Bases?`
                }`}
            </SpaceBetween>{" "}
        </Modal>
    );

    const createKbModal = (
        <Modal
            onDismiss={() => setShowKbCreationModal(false)}
            visible={showKbCreationModal}
            header={"Knowledge Base Creation Process"}
        >
            <SpaceBetween direction="vertical" size="m">
                {creationStatus && (
                    <Flashbar
                        items={[
                            {
                                type: creationStatus === "failed" ? "error" : "success",
                                content:
                                    creationStatus === "failed"
                                        ? "Failed to create a Knowledge Base"
                                        : creationStatus === "in-progress"
                                          ? `Creation in progress...`
                                          : "Successful",
                                loading: creationStatus === "in-progress",
                                id: `message-kb-${creationStatus}`,
                            },
                        ]}
                    />
                )}
            </SpaceBetween>{" "}
        </Modal>
    );
    // ---------------------------------------------------------------------------------- //

    // ---------------------------------------------------------------------------------- //
    //                          Sync
    // ---------------------------------------------------------------------------------- //
    useEffect(() => {
        if (selectedItems.length !== 1) return;

        const checkSync = async () => {
            try {
                const response = await apiClient.graphql({
                    query: checkOnSyncInProgressQuery,
                    variables: { kbId: selectedItems[0].id },
                });
                setSyncStatus(response.data?.checkOnSyncInProgress ? "in-progress" : undefined);
            } catch (error) {
                console.error("Error checking sync status:", error);
                setSyncStatus(undefined);
            }
        };

        checkSync();
    }, [selectedItems]);

    const launchSync = async () => {
        if (!appContext) return;

        try {
            console.log("sync started");
            const response = await apiClient.graphql({
                query: syncKnowledgeBaseMut,
                variables: { kbId: selectedItems[0].id },
            });
            if (response.data.syncKnowledgeBase.status === ResponseStatus.SUCCESSFUL) {
                setSyncStatus("success");
            } else {
                setSyncStatus("failed");
            }
        } catch (err) {
            setSyncStatus("failed");
            console.error("Sync start failed");
        }
    };

    // ---------------------------------------------------------------------------------- //
    //                          Table fancy stuff
    // ---------------------------------------------------------------------------------- //
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

    const { items, actions, collectionProps, filterProps, filteredItemsCount, paginationProps } =
        useCollection(knowledgeBases, {
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
            filtering: {
                empty: (
                    <EmptyState
                        title={`No knowledge bases found`}
                        action={
                            <Button
                                onClick={() =>
                                    setKbConfigDialog({
                                        ...resetKbConfigDialogValue,
                                        visible: true,
                                    })
                                }
                            ></Button>
                        }
                    />
                ),
                noMatch: (
                    <EmptyState
                        title="No matches"
                        action={
                            <Button onClick={() => actions.setFiltering("")}>Clear filter</Button>
                        }
                    />
                ),
            },
        });
    // ---------------------------------------------------------------------------------- //

    return (
        <Container>
            {syncStatus && selectedItems.length === 1 && (
                <Alert
                    dismissible
                    type={syncStatus === "failed" ? "error" : "info"}
                    onDismiss={() => setSyncStatus(undefined)}
                >
                    {syncStatus === "failed"
                        ? `Failed to start synchronization of Knowledge Base ${selectedItems[0].name}`
                        : `Knowledge Base ${selectedItems[0].id} is syncing`}
                </Alert>
            )}
            <Table
                {...collectionProps}
                items={items}
                onSelectionChange={({ detail }) => {
                    setSelectedItems(detail.selectedItems);
                }}
                selectedItems={selectedItems}
                selectionType="multi"
                trackBy="name"
                loading={isLoading}
                loadingText={tableLoadingText}
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
                        description="List of knowledge bases"
                        variant="awsui-h1-sticky"
                        actions={
                            <SpaceBetween direction="horizontal" size="l" alignItems="center">
                                <KbConfigurationManager
                                    configDialog={kbConfigDialog}
                                    setConfigDialog={setKbConfigDialog}
                                />
                                <DataSourceConfigurationManager
                                    configDialog={dsConfigDialog}
                                    setConfigDialog={setDsConfigDialog}
                                />
                                <Button
                                    iconAlt="add-kb"
                                    iconName="add-plus"
                                    variant="inline-link"
                                    onClick={() => setShowKbCreationWizard(true)}
                                >
                                    {"New Knowledge Base"}
                                </Button>
                                <Button
                                    iconAlt="refresh-list"
                                    iconName="refresh"
                                    variant="inline-link"
                                    onClick={() => fetchKnowledgeBases()}
                                >
                                    {"Refresh"}
                                </Button>
                                {/* <Button
                                    disabled={selectedItems.length !== 1}
                                    iconAlt="describe-kb"
                                    iconName="zoom-in"
                                    variant="inline-link"
                                    onClick={() => fetchKnowledgeBases()} // TODO update
                                >
                                    {"Describe"}
                                </Button> */}
                                <Button
                                    disabled={selectedItems.length !== 1}
                                    iconAlt="sync-kb"
                                    iconName="heart"
                                    variant="inline-link"
                                    onClick={launchSync}
                                >
                                    {"Sync"}
                                </Button>
                                <Button
                                    disabled={
                                        selectedItems.length !== 1 ||
                                        selectedItems.some(
                                            (item) => item.owner.toLowerCase() === "admin",
                                        )
                                    }
                                    iconAlt="add-ds"
                                    iconName="upload"
                                    variant="inline-link"
                                    onClick={() =>
                                        setDsConfigDialog({
                                            ...resetDsConfigDialogValue,
                                            visible: true,
                                            kbId: selectedItems[0].id,
                                        })
                                    }
                                >
                                    {"Add data source"}
                                </Button>
                                <Button
                                    disabled={
                                        selectedItems.length !== 1 ||
                                        selectedItems.some(
                                            (item) => item.owner.toLowerCase() === "admin",
                                        )
                                    }
                                    iconAlt="rm-ds"
                                    iconName="undo"
                                    variant="inline-link"
                                    onClick={() => setShowDsModalDelete(true)}
                                >
                                    {"Remove data source"}
                                </Button>
                                <Button
                                    disabled={
                                        selectedItems.length == 0 ||
                                        selectedItems.some(
                                            (item) => item.owner.toLowerCase() === "admin",
                                        )
                                    }
                                    iconAlt="rm-kb"
                                    iconName="remove"
                                    variant="inline-link"
                                    onClick={() => setShowKbModalDelete(true)}
                                >
                                    {"Remove knowledge base"}
                                </Button>
                            </SpaceBetween>
                        }
                    ></Header>
                }
                filter={
                    <TextFilter
                        {...filterProps}
                        countText={`${filteredItemsCount} matches`}
                        filteringAriaLabel="Filter instances"
                    />
                }
                columnDefinitions={[
                    {
                        id: "id",
                        header: "Id",
                        cell: (item) => item.id,
                        isRowHeader: true,
                    },
                    {
                        id: "name",
                        header: "Name",
                        cell: (item) => item.name,
                        isRowHeader: true,
                    },
                    {
                        id: "description",
                        header: "Description",
                        cell: (item) => item.description,
                        isRowHeader: true,
                    },
                    {
                        id: "owner",
                        header: "Owner",
                        cell: (item) =>
                            item.owner === "Admin"
                                ? "admin"
                                : item.owner === StorageHelper.getUserId()
                                  ? StorageHelper.getUserName()
                                  : "Someone else",
                        isRowHeader: true,
                    },
                ]}
            />
            {deleteDsModal}
            {deleteKbModal}
            {showKbCreationWizard && (
                <KnowledgeBaseCreationWizard
                    onSubmit={handleKbCreation}
                    onCancel={() => setShowKbCreationWizard(false)}
                />
            )}
            {createKbModal}
        </Container>
    );
}
