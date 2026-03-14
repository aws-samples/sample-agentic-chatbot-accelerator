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
    FileUpload,
    Flashbar,
    FormField,
    Header,
    Modal,
    Pagination,
    ProgressBar,
    Select,
    SpaceBetween,
    Table,
    TextFilter,
} from "@cloudscape-design/components";
import { useCallback, useContext, useEffect, useState } from "react";

import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";

import { generateClient } from "aws-amplify/api";
import { uploadData } from "aws-amplify/storage";

import { KnowledgeBase, S3DataSource, S3Document } from "../../API";
import {
    batchUpdateMetadata as batchUpdateMetadataMut,
    deleteDocument as deleteDocumentMut,
    syncKnowledgeBase as syncKnowledgeBaseMut,
} from "../../graphql/mutations";
import {
    checkOnDocumentsRemoved as checkOnDocumentsRemovedQuery,
    checkOnProcessCompleted as checkOnProcessCompletedQuery,
    checkOnProcessStarted as checkOnProcessStartedQuery,
    getDocumentMetadata as getDocumentMetadataQuery,
    getInputPrefix as getInputPrefixQuery,
    getPresignedUrl as getPresignedUrlQuery,
    listDataSources as listDataSourcesQuery,
    listDocuments as listDocumentsQuery,
    listKnowledgeBases as listKnowledgeBasesQuery,
} from "../../graphql/queries";

import { StorageHelper } from "../../common/helpers/storage-helper";
import styles from "../../styles/admin.module.scss";
import { MetadataUpdateManager } from "./configure/metadata-config";
import { MetadataConfig, OperationStatus } from "./configure/types";

import { ResponseStatus } from "../../API";

type StatusMessage = {
    status: OperationStatus;
    message: string;
};
export interface DocumentManagerProps {
    readonly toolsOpen: boolean;
}

export default function DocumentManager(props: DocumentManagerProps) {
    const appContext = useContext(AppContext);
    // state saves options for knowledge bases - to set with query
    const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
    const [selectedKB, setSelectedKB] = useState<KnowledgeBase | null>(null);
    const [isLoadingKB, setIsLoadingKB] = useState<boolean>(false);
    // state saves options for data sources- to set with query
    const [dataSources, setDataSources] = useState<S3DataSource[]>([]);
    const [selectedDS, setSelectedDS] = useState<S3DataSource | null>(null);
    const [isLoadingDS, setIsLoadingDS] = useState<boolean>(false);
    // state for loading tables
    const [tableLoading, setTableLoading] = useState<boolean>(false);
    const [tableLoadingText, setTableLoadingText] = useState<string>("");
    // state for documents
    const [documents, setDocuments] = useState<S3Document[]>([]);
    const [selectedItems, setSelectedItems] = useState<S3Document[]>([]);
    const [preferences, setPreferences] = useState({ pageSize: 20 });
    // states for document upload
    const [uploadModalVisible, setUploadModalVisible] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    // states for document delete
    const [showModalDelete, setShowModalDelete] = useState(false);
    // states for metadata
    const resetMetadataConfigDialog: MetadataConfig = {
        visible: false,
        id: "",
        value: "",
        kbId: "",
    };
    const [metadataDialog, setMetadataDialog] = useState<MetadataConfig>(resetMetadataConfigDialog);
    const [metadataFile, setMetadataFile] = useState<File[]>([]);
    const [metadataBatchUploadVisible, setMetadataBatchUploadVisible] = useState<boolean>(false);
    const [metadataProcessingStatus, setMetadataProcessingStatus] = useState<
        StatusMessage | undefined
    >(undefined);

    // --------------------------------------------------------------------------------------------- //
    const apiClient = generateClient();

    const fetchKnowledgeBases = useCallback(async () => {
        if (!appContext) return;

        try {
            setIsLoadingKB(true);
            const result = await apiClient.graphql({ query: listKnowledgeBasesQuery });
            setKnowledgeBases(result.data!.listKnowledgeBases);
            setIsLoadingKB(false);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        }
    }, [appContext]);

    const fetchDataSources = useCallback(async () => {
        if (!appContext || !selectedKB) return;

        try {
            setIsLoadingDS(true);
            const result = await apiClient.graphql({
                query: listDataSourcesQuery,
                variables: {
                    kbId: selectedKB.id,
                },
            });
            setDataSources(result.data!.listDataSources);
            setIsLoadingDS(false);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        }
    }, [appContext, selectedKB]);

    useEffect(() => {
        fetchKnowledgeBases();
    }, [props.toolsOpen]);

    useEffect(() => {
        fetchDataSources();
    }, [selectedKB]);

    const listDocuments = useCallback(async () => {
        if (!appContext || !selectedKB || !selectedDS) return;

        try {
            const result = await apiClient.graphql({
                query: listDocumentsQuery,
                variables: {
                    prefixes: selectedDS.prefixes,
                },
            });
            setDocuments(result.data.listDocuments);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        }
    }, [appContext, selectedKB, selectedDS]);

    useEffect(() => {
        if (!appContext || !selectedKB || !selectedDS) return;

        (async () => {
            setTableLoading(true);
            setTableLoadingText("Fetching documents...");
            await listDocuments();
            setTableLoading(false);
        })();
    }, [selectedKB, selectedDS]);

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
    }; //
    const { items, actions, collectionProps, filterProps, filteredItemsCount, paginationProps } =
        useCollection(documents, {
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
                        title={`No documents found in the data source ${selectedDS?.name}`}
                        action={
                            <Button onClick={() => setUploadModalVisible(true)}>
                                Upload documents
                            </Button>
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

    const pollForProcessStarted = async (
        prefix: string,
        selectedFiles: File[],
    ): Promise<boolean> => {
        const POLLING_INTERVAL = 3000;
        const TIMEOUT = 5 * 60 * 1000;
        const startTime = Date.now();

        while (true) {
            try {
                const result = await apiClient.graphql({
                    query: checkOnProcessStartedQuery,
                    variables: {
                        s3ObjectNames: selectedFiles.map((file) => `${prefix}/${file.name}`),
                    },
                });

                if (result.data.checkOnProcessStarted === true) {
                    return true;
                }

                if (Date.now() - startTime >= TIMEOUT) {
                    throw new Error("Polling timed out after 5 minutes");
                }

                await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
            } catch (error) {
                // If query fails, stop polling and throw the error
                throw error;
            }
        }
    };
    const pollForProcessCompleted = async (
        prefix: string,
        selectedFiles: File[],
    ): Promise<boolean> => {
        const POLLING_INTERVAL = 10000;
        const TIMEOUT = 30 * 60 * 1000;
        const startTime = Date.now();

        while (true) {
            try {
                const result = await apiClient.graphql({
                    query: checkOnProcessCompletedQuery,
                    variables: {
                        s3ObjectNames: selectedFiles.map((file) => `${prefix}/${file.name}`),
                    },
                });

                if (result.data.checkOnProcessCompleted === true) {
                    return true;
                }

                if (Date.now() - startTime >= TIMEOUT) {
                    throw new Error("Polling timed out after 3O minutes");
                }

                await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
            } catch (error) {
                throw error;
            }
        }
    };
    const pollForDeletionCompleted = async (selectedItems: S3Document[]): Promise<boolean> => {
        const POLLING_INTERVAL = 3000;
        const TIMEOUT = 30 * 60 * 1000;
        const startTime = Date.now();

        while (true) {
            try {
                const result = await apiClient.graphql({
                    query: checkOnDocumentsRemovedQuery,
                    variables: {
                        s3ObjectNames: selectedItems.map((object) => {
                            const parts = object.uri.replace("s3://", "").split("/");
                            console.log("S3 URI parts:", JSON.stringify(parts));
                            if (parts.length < 2) {
                                throw new Error("Invalid S3 URI format");
                            }

                            return parts.slice(1).join("/");
                        }),
                    },
                });

                if (result.data.checkOnDocumentsRemoved === true) {
                    return true;
                }

                if (Date.now() - startTime >= TIMEOUT) {
                    throw new Error("Polling timed out after 10 minutes");
                }

                await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
            } catch (error) {
                throw error;
            }
        }
    };

    const handleFileUpload = async () => {
        if (!selectedFiles.length || !selectedKB || !selectedDS || !appContext) return;

        setUploadError(null);

        // Find the most common input prefix from documents
        const prefixResult = await apiClient.graphql({
            query: getInputPrefixQuery,
            variables: {
                kbId: selectedKB.id,
                dataSourceID: selectedDS.id,
            },
        });

        const prefix = prefixResult.data.getInputPrefix;
        try {
            const uploadPromises = selectedFiles.map(async (file) => {
                const key = `${prefix}/${file.name}`;
                try {
                    const result = await uploadData({
                        path: key,
                        data: file,
                        options: {
                            contentType: file.type,
                            onProgress: ({ transferredBytes, totalBytes }) => {
                                if (!totalBytes) return;

                                const percentage = (transferredBytes / totalBytes) * 100;
                                setUploadProgress((prev) => ({
                                    ...prev,
                                    [file.name]: percentage,
                                }));
                            },
                        },
                    }).result;

                    return result;
                } catch (error) {
                    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
                    console.error("Error uploading file:", file.name, error);
                    throw error;
                }
            });

            await Promise.all(uploadPromises);
            setUploadModalVisible(false);
            setUploadProgress({});
            setSelectedFiles([]);

            setTableLoading(true);
            setTableLoadingText("Initializing process...");

            try {
                await pollForProcessStarted(prefix!, selectedFiles);
                console.log("Processing successfully started");
            } catch (error) {
                console.error("Polling failed");
            }
            setTableLoadingText("Processing...");
            try {
                await pollForProcessCompleted(prefix!, selectedFiles);
                console.log("Process pipeline successfully completed");
            } catch (error) {
                console.error("Polling failed");
            }

            setTableLoadingText("Fetching documents...");
            await listDocuments();
            setTableLoading(false);
        } catch (error) {}
    };

    const uploadModal = (
        <Modal
            visible={uploadModalVisible}
            onDismiss={() => {
                setUploadModalVisible(false);
                setSelectedFiles([]);
                setUploadProgress({});
                setUploadError(null);
            }}
            header="Upload Documents"
            closeAriaLabel="Close modal"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={() => setUploadModalVisible(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleFileUpload}
                            disabled={selectedFiles.length === 0}
                        >
                            Upload
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween size="l">
                <FileUpload
                    onChange={({ detail }) => {
                        setSelectedFiles(detail.value);
                        setUploadError(null);
                    }}
                    value={selectedFiles}
                    i18nStrings={{
                        uploadButtonText: () => `Choose files`,
                        dropzoneText: () => `Drop files to upload`,
                        removeFileAriaLabel: (e) => `Remove file ${e + 1}`,
                        limitShowFewer: "Show fewer files",
                        limitShowMore: "Show more files",
                        errorIconAriaLabel: "Error",
                    }}
                    multiple
                    showFileLastModified
                    showFileSize
                    tokenLimit={3}
                    constraintText="File types supported: PDF, DOC, DOCX, TXT, MD, MP4, MOV, MP3, PPT, PPTX, PPS, PPSX, ODP"
                    accept=".pdf,.doc,.docx,.txt,.md,.mp4,.mov,.mp3,.ppt,.pptx,.pps,.ppsx,.odp"
                    errorText={uploadError}
                />

                {Object.entries(uploadProgress).map(([fileName, progress]) => (
                    <Box key={fileName}>
                        <Box variant="p">{fileName}</Box>
                        <ProgressBar value={progress} label={`${Math.round(progress)}%`} />
                    </Box>
                ))}
            </SpaceBetween>
        </Modal>
    );

    const deleteSelectedDocuments = async () => {
        if (!appContext) return;

        try {
            await Promise.all(
                selectedItems.map((s) =>
                    apiClient.graphql({
                        query: deleteDocumentMut,
                        variables: { uri: s.uri },
                    }),
                ),
            );
        } catch (error) {
            console.error("Error deleting documents:", error);
        }

        setShowModalDelete(false);

        setTableLoading(true);
        setTableLoadingText("Cleaning up documents...");

        try {
            await pollForDeletionCompleted(selectedItems);
            console.log("Document successfully deleted...");
        } catch (error) {
            console.error(`Polling failed: ${error}`);
        }
        setTableLoadingText("Fetching documents...");

        await listDocuments();
        setTableLoading(false);

        setSelectedItems([]);
    };

    const deleteModal = (
        <Modal
            onDismiss={() => setShowModalDelete(false)}
            visible={showModalDelete}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        {" "}
                        <Button variant="link" onClick={() => setShowModalDelete(false)}>
                            {"Cancel"}
                        </Button>
                        <Button variant="primary" onClick={deleteSelectedDocuments}>
                            {"OK"}
                        </Button>
                    </SpaceBetween>{" "}
                </Box>
            }
            header={"Delete session" + (selectedItems.length > 1 ? "s" : "")}
        >
            {"Do you want to delete"}{" "}
            {selectedItems.length == 1
                ? `the document "${selectedItems[0].name}"?`
                : `${selectedItems.length} documents?`}
        </Modal>
    );

    // ---------------------------- //
    // ---      Metadata        --- //
    // ---------------------------- //
    const fetchMetadata = useCallback(async () => {
        if (!appContext || !selectedKB || !selectedDS || selectedItems.length != 1) return;

        try {
            const result = await apiClient.graphql({
                query: getDocumentMetadataQuery,
                variables: {
                    documentId: selectedItems[0].id,
                },
            });
            const metadata = result.data.getDocumentMetadata;
            console.log(metadata);
            setMetadataDialog({
                ...resetMetadataConfigDialog,
                id: selectedItems[0].id,
                value: result.data.getDocumentMetadata,
                kbId: selectedKB.id,
            });
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
        }
    }, [selectedItems]);

    const resetMetadataModal = () => {
        setMetadataBatchUploadVisible(false);
        setMetadataFile([]);
        setUploadError(null);
        setMetadataProcessingStatus(undefined);
    };

    const handleMetadataBatchUpload = async () => {
        if (!selectedKB || !selectedDS || !appContext || metadataFile.length !== 1) return;

        const handleFailure = (error?: any) => {
            setMetadataProcessingStatus({
                status: "failed",
                message: "Metadata update failed",
            });
            if (error) {
                console.error("Error uploading metadata file:", metadataFile[0].name, error);
                throw error;
            }
        };

        try {
            const s3Key = `metadata/${StorageHelper.getUserId()}/${Date.now()}.jsonl`;

            setMetadataProcessingStatus({
                status: "in-progress",
                message: "Uploading metadata file...",
            });
            await uploadData({
                path: s3Key,
                data: metadataFile[0],
                options: {
                    contentType: metadataFile[0].type,
                },
            });

            await new Promise((resolve) => setTimeout(resolve, 1000));

            setMetadataProcessingStatus({
                status: "in-progress",
                message: "Updating documents'metadata...",
            });

            const response = await apiClient.graphql({
                query: batchUpdateMetadataMut,
                variables: {
                    metadataFile: s3Key,
                },
            });
            if (response.data.batchUpdateMetadata.status !== ResponseStatus.SUCCESSFUL) {
                return handleFailure();
            }
            setMetadataProcessingStatus({
                status: "in-progress",
                message: "Syncing the Knowledge Base",
            });

            const syncResponse = await apiClient.graphql({
                query: syncKnowledgeBaseMut,
                variables: {
                    kbId: selectedKB.id,
                },
            });

            if (syncResponse.data.syncKnowledgeBase.status !== ResponseStatus.SUCCESSFUL) {
                return handleFailure();
            }

            setMetadataProcessingStatus({
                status: "success",
                message: "Completed",
            });
            setTimeout(() => {
                resetMetadataModal();
            }, 1000);
        } catch (error) {
            handleFailure(error);
        }
    };

    const metadataBatchModal = (
        <Modal
            visible={metadataBatchUploadVisible}
            onDismiss={resetMetadataModal}
            header="Upload file for batch update of metadata"
            closeAriaLabel="Close modal"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={resetMetadataModal}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleMetadataBatchUpload}
                            disabled={metadataFile.length !== 1}
                        >
                            Upload
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween size="l">
                {metadataProcessingStatus && (
                    <Flashbar
                        items={[
                            {
                                type:
                                    metadataProcessingStatus.status === "failed"
                                        ? "error"
                                        : "success",
                                content: metadataProcessingStatus.message,
                                loading: metadataProcessingStatus.status === "in-progress",
                                id: "message-metadata-batch-processing",
                            },
                        ]}
                    />
                )}
                <FileUpload
                    onChange={({ detail }) => {
                        setMetadataFile(detail.value);
                        setUploadError(null);
                    }}
                    value={metadataFile}
                    i18nStrings={{
                        uploadButtonText: () => `Choose files`,
                        dropzoneText: () => `Drop files to upload`,
                        removeFileAriaLabel: (e) => `Remove file ${e + 1}`,
                        limitShowFewer: "Show fewer files",
                        limitShowMore: "Show more files",
                        errorIconAriaLabel: "Error",
                    }}
                    showFileLastModified
                    showFileSize
                    tokenLimit={3}
                    constraintText="File types supported: JSONL"
                    accept=".jsonl"
                    errorText={uploadError}
                />

                {Object.entries(uploadProgress).map(([fileName, progress]) => (
                    <Box key={fileName}>
                        <Box variant="p">{fileName}</Box>
                        <ProgressBar value={progress} label={`${Math.round(progress)}%`} />
                    </Box>
                ))}
            </SpaceBetween>
        </Modal>
    );

    return (
        <Container header="Document Manager">
            <div className={styles.document_container}>
                <FormField label="Knowledge Base">
                    <Select
                        data-locator="select-knowledge-base"
                        placeholder="Select a Knowledge Base"
                        loadingText="Loading Knowledge Bases"
                        statusType={isLoadingKB ? "loading" : undefined}
                        filteringType="auto"
                        selectedOption={
                            selectedKB
                                ? {
                                      value: JSON.stringify(selectedKB),
                                      label: selectedKB.name,
                                  }
                                : null
                        }
                        onChange={({ detail }) => {
                            if (!detail.selectedOption.value) return;
                            setSelectedKB(JSON.parse(detail.selectedOption.value) as KnowledgeBase);
                            setSelectedDS(null);
                        }}
                        options={knowledgeBases.map((kb) => ({
                            value: JSON.stringify(kb),
                            label: kb.name,
                        }))}
                    />
                </FormField>
                <FormField label="Data Sources">
                    <Select
                        data-locator="select-data-sources"
                        placeholder="Select a Data Source"
                        loadingText="Loading Data Sources"
                        statusType={isLoadingDS ? "loading" : undefined}
                        filteringType="auto"
                        disabled={!selectedKB}
                        selectedOption={
                            selectedDS
                                ? {
                                      value: JSON.stringify(selectedDS),
                                      label: selectedDS.name,
                                  }
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
                    />
                </FormField>
            </div>
            {selectedKB && selectedDS && (
                <Table
                    {...collectionProps}
                    items={items}
                    onSelectionChange={({ detail }) => {
                        setSelectedItems(detail.selectedItems);
                    }}
                    selectedItems={selectedItems}
                    selectionType="multi"
                    trackBy="name"
                    loading={tableLoading}
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
                            description="Documents"
                            variant="awsui-h1-sticky"
                            actions={
                                <SpaceBetween direction="horizontal" size="xl" alignItems="center">
                                    <MetadataUpdateManager
                                        configDialog={metadataDialog}
                                        setConfigDialog={setMetadataDialog}
                                    />

                                    <Button
                                        iconAlt="Add"
                                        iconName="add-plus"
                                        variant="inline-link"
                                        onClick={() => setUploadModalVisible(true)}
                                    >
                                        {"Upload documents"}
                                    </Button>
                                    <Button
                                        iconAlt="Refresh"
                                        iconName="refresh"
                                        variant="inline-link"
                                        onClick={async () => {
                                            setTableLoading(true);
                                            setTableLoadingText("Fetching documents...");
                                            await listDocuments();
                                            setTableLoading(false);
                                        }}
                                    >
                                        {"Refresh"}
                                    </Button>
                                    <Button
                                        iconAlt="Add"
                                        iconName="add-plus"
                                        variant="inline-link"
                                        onClick={() => setMetadataBatchUploadVisible(true)}
                                    >
                                        {"Metadata batch upload"}
                                    </Button>
                                    <Button
                                        disabled={selectedItems.length != 1}
                                        iconAlt="View config"
                                        iconName="view-full"
                                        variant="inline-link"
                                        onClick={async () => {
                                            await fetchMetadata();

                                            setMetadataDialog(
                                                (previousConfigDialog: MetadataConfig) => ({
                                                    ...previousConfigDialog,
                                                    visible: true,
                                                }),
                                            );
                                        }}
                                    >
                                        {"View Metadata"}
                                    </Button>
                                    <Button
                                        disabled={selectedItems.length == 0}
                                        iconAlt="Delete"
                                        iconName="delete-marker"
                                        variant="inline-link"
                                        onClick={() => setShowModalDelete(true)}
                                    >
                                        {"Delete"}
                                    </Button>
                                </SpaceBetween>
                            }
                        >
                            {"Data source content"}
                        </Header>
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
                            cell: (item) => (
                                <Button
                                    variant="link"
                                    loading={false}
                                    iconAlign="left"
                                    onClick={async (event) => {
                                        event.preventDefault();
                                        try {
                                            const response = await apiClient.graphql({
                                                query: getPresignedUrlQuery,
                                                variables: {
                                                    s3Uri: item.uri,
                                                },
                                            });
                                            window.open(response.data.getPresignedUrl!, "_blank");
                                        } catch (error) {
                                            console.error("Error generating presigned URL:", error);
                                        }
                                    }}
                                >
                                    {item.id}
                                </Button>
                            ),
                            isRowHeader: true,
                        },
                        {
                            id: "name",
                            header: "Name",
                            cell: (item) => item.name,
                            sortingField: "name",
                            isRowHeader: true,
                        },
                        {
                            id: "type",
                            header: "Type",
                            cell: (item) => item.documentType,
                            isRowHeader: true,
                        },
                    ]}
                    data-locator="documents-table"
                />
            )}
            {uploadModal}
            {deleteModal}
            {metadataBatchModal}
        </Container>
    );
}
