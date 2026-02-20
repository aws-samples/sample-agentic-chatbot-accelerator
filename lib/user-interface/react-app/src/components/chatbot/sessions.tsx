/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    ...
*/
import { useCollection } from "@cloudscape-design/collection-hooks";
import {
    Alert,
    Box,
    Button,
    CollectionPreferences,
    Header,
    Input,
    Modal,
    Pagination,
    SpaceBetween,
    Table,
    TableProps,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { DateTime } from "luxon";
import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { Session } from "../../API";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import {
    deleteSession as deleteSessionMut,
    deleteUserSessions as deleteUserSessionsMut,
    renameSession as renameSessionMut,
} from "../../graphql/mutations";
import { listSessions as listSessionQuery } from "../../graphql/queries";
import RouterButton from "../wrappers/router-button";

export interface SessionsProps {
    readonly toolsOpen: boolean;
}

export default function Sessions(props: SessionsProps) {
    const appContext = useContext(AppContext);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedItems, setSelectedItems] = useState<Session[]>([]);
    const [preferences, setPreferences] = useState({ pageSize: 20 });
    const [showModalDelete, setShowModalDelete] = useState(false);
    const [deleteAllSessions, setDeleteAllSessions] = useState(false);
    const [globalError, setGlobalError] = useState<string | undefined>(undefined);
    // Rename session states
    const [showRenameModal, setShowRenameModal] = useState(false);
    const [renameSessionId, setRenameSessionId] = useState("");
    const [renameValue, setRenameValue] = useState("");

    const { t } = useTranslation("ACA");

    const { items, collectionProps, paginationProps } = useCollection(sessions, {
        filtering: {
            empty: (
                <Box margin={{ vertical: "xs" }} textAlign="center" color="inherit">
                    <SpaceBetween size="m">
                        <b>{t("CHATBOT.SESSIONS.EMPTY_MSG")}</b>
                    </SpaceBetween>
                </Box>
            ),
        },
        pagination: { pageSize: preferences.pageSize },
        sorting: {
            defaultState: {
                sortingColumn: {
                    sortingField: "startTime",
                },
                isDescending: true,
            },
        },
        selection: {},
    });

    const listSessions = useCallback(async () => {
        if (!appContext) return;

        const apiClient = generateClient();
        try {
            setGlobalError(undefined);
            const result = await apiClient.graphql({
                query: listSessionQuery,
            });
            setSessions(result.data!.listSessions);
        } catch (error) {
            console.log(Utils.getErrorMessage(error));
            setGlobalError(Utils.getErrorMessage(error));
            setSessions([]);
        }
    }, [appContext]);

    useEffect(() => {
        if (!appContext) return;

        (async () => {
            setIsLoading(true);
            await listSessions();
            setIsLoading(false);
        })();
    }, [appContext, listSessions, props.toolsOpen]);

    const deleteSelectedSessions = async () => {
        if (!appContext) return;

        setIsLoading(true);
        const apiClient = generateClient();
        await Promise.all(
            selectedItems.map((s) =>
                apiClient.graphql({
                    query: deleteSessionMut,
                    variables: { id: s.id },
                }),
            ),
        );
        await listSessions();
        setIsLoading(false);
        setShowModalDelete(false);
    };

    const deleteUserSessions = async () => {
        if (!appContext) return;

        setIsLoading(true);
        const apiClient = generateClient();
        await apiClient.graphql({ query: deleteUserSessionsMut });
        await listSessions();
        setIsLoading(false);
        setDeleteAllSessions(false);
    };

    // Rename session modal
    const renameSessionModal = (
        <Modal
            onDismiss={() => setShowRenameModal(false)}
            visible={showRenameModal}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={() => setShowRenameModal(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={async () => {
                                // console.log("Rename session", renameSessionId, "to:", renameValue);
                                const apiClient = generateClient();
                                try {
                                    await apiClient.graphql({
                                        query: renameSessionMut,
                                        variables: { id: renameSessionId, title: renameValue },
                                    });
                                    setIsLoading(true);
                                    await listSessions();
                                    setIsLoading(false);
                                } catch (error) {
                                    console.error("Failed to change the session title");
                                }
                                setShowRenameModal(false);
                            }}
                        >
                            Save
                        </Button>
                    </SpaceBetween>
                </Box>
            }
            header="Enter new session title"
        >
            <Input
                value={renameValue}
                onChange={({ detail }) => setRenameValue(detail.value)}
                placeholder="Enter new session title"
            />
        </Modal>
    );

    return (
        <>
            <Modal
                onDismiss={() => setShowModalDelete(false)}
                visible={showModalDelete}
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            {" "}
                            <Button variant="link" onClick={() => setShowModalDelete(false)}>
                                {t("CHATBOT.SESSIONS.CANCEL_BUTTON")}
                            </Button>
                            <Button variant="primary" onClick={deleteSelectedSessions}>
                                {t("CHATBOT.SESSIONS.OK_BUTTON")}
                            </Button>
                        </SpaceBetween>{" "}
                    </Box>
                }
                header={"Delete session" + (selectedItems.length > 1 ? "s" : "")}
            >
                {t("CHATBOT.SESSIONS.DELETE_MSG")}{" "}
                {selectedItems.length == 1
                    ? `session ${selectedItems[0].id}?`
                    : `${selectedItems.length} sessions?`}
            </Modal>
            <Modal
                onDismiss={() => setDeleteAllSessions(false)}
                visible={deleteAllSessions}
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            {" "}
                            <Button variant="link" onClick={() => setDeleteAllSessions(false)}>
                                {t("CHATBOT.SESSIONS.CANCEL_BUTTON")}
                            </Button>
                            <Button variant="primary" onClick={deleteUserSessions}>
                                {t("CHATBOT.SESSIONS.OK_BUTTON")}
                            </Button>
                        </SpaceBetween>{" "}
                    </Box>
                }
                header={"Delete all sessions"}
            >
                {`${t("CHATBOT.SESSIONS.DELETE_MSG")} ${sessions.length} sessions?`}
            </Modal>
            {globalError && (
                <Alert
                    statusIconAriaLabel="Error"
                    type="error"
                    header="Unable to load the sessions."
                >
                    {globalError}
                </Alert>
            )}
            <Table
                {...collectionProps}
                variant="full-page"
                items={items}
                onSelectionChange={({ detail }) => {
                    setSelectedItems(detail.selectedItems);
                }}
                selectedItems={selectedItems}
                selectionType="multi"
                trackBy="id"
                empty={
                    <Box margin={{ vertical: "xs" }} textAlign="center" color="inherit">
                        <SpaceBetween size="m">
                            <b>{t("CHATBOT.SESSIONS.EMPTY_MSG")}</b>
                        </SpaceBetween>
                    </Box>
                }
                ariaLabels={{
                    selectionGroupLabel: "Items selection",
                    allItemsSelectionLabel: ({ selectedItems }) =>
                        `${selectedItems.length} ${
                            selectedItems.length === 1 ? "item" : "items"
                        } selected`,
                    // @ts-expect-error no-unused-var
                    itemSelectionLabel: (e, item) => item.title!,
                }}
                pagination={<Pagination {...paginationProps} />}
                loadingText="Loading history"
                loading={isLoading}
                resizableColumns
                stickyHeader={true}
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
                        description="List of past sessions"
                        variant="awsui-h1-sticky"
                        actions={
                            <SpaceBetween direction="horizontal" size="m" alignItems="center">
                                <RouterButton
                                    iconName="add-plus"
                                    href={`/${uuidv4()}`}
                                    variant="inline-link"
                                >
                                    {t("CHATBOT.SESSIONS.NEW_BUTTON")}
                                </RouterButton>
                                <Button
                                    iconAlt="Refresh list"
                                    iconName="refresh"
                                    variant="inline-link"
                                    onClick={async () => {
                                        setIsLoading(true);
                                        await listSessions();
                                        setIsLoading(false);
                                    }}
                                >
                                    {t("CHATBOT.SESSIONS.REFRESH")}
                                </Button>
                                <Button
                                    disabled={selectedItems.length == 0}
                                    iconAlt="Delete"
                                    iconName="remove"
                                    variant="inline-link"
                                    onClick={() => {
                                        if (selectedItems.length > 0) setShowModalDelete(true);
                                    }}
                                >
                                    {t("CHATBOT.SESSIONS.DELETE")}
                                </Button>
                                <Button
                                    iconAlt="Delete all sessions"
                                    iconName="delete-marker"
                                    variant="inline-link"
                                    onClick={() => setDeleteAllSessions(true)}
                                >
                                    {t("CHATBOT.SESSIONS.DELETE_ALL_MSG")}
                                </Button>
                            </SpaceBetween>
                        }
                    >
                        {t("CHATBOT.SESSIONS.PAGE_TITLE")}
                    </Header>
                }
                columnDefinitions={
                    [
                        {
                            id: "title",
                            header: "Title",
                            sortingField: "title",
                            width: 600,
                            cell: (e) => (
                                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                                    <Link to={`/${e.id}`}>
                                        {e.title && e.title?.length > 100
                                            ? `${e.title.substring(0, 100)}...`
                                            : e.title}
                                    </Link>
                                    <Button
                                        variant="icon"
                                        iconName="edit"
                                        onClick={() => {
                                            setRenameSessionId(e.id);
                                            if (e.title) {
                                                setRenameValue(e.title);
                                            }
                                            setShowRenameModal(true);
                                        }}
                                    />
                                </SpaceBetween>
                            ),
                            isRowHeader: true,
                        },

                        {
                            id: "startTime",
                            header: "Time",
                            sortingField: "startTime",
                            width: 200,
                            cell: (e: Session) =>
                                DateTime.fromISO(
                                    new Date(e.startTime).toISOString(),
                                ).toLocaleString(DateTime.DATETIME_SHORT),
                            sortingComparator: (a, b) => {
                                return (
                                    new Date(b.startTime).getTime() -
                                    new Date(a.startTime).getTime()
                                );
                            },
                        },
                        {
                            id: "agentName",
                            header: "AgentName",
                            width: 200,
                            cell: (e) => e.runtimeId.split("-")[0],
                        },
                        {
                            id: "runtimeVersion",
                            header: "RuntimeVersion",
                            width: 200,
                            cell: (e) => e.runtimeVersion,
                        },
                        {
                            id: "endpoint",
                            header: "Endpoint",
                            width: 200,
                            cell: (e) => e.endpoint,
                        },
                    ] as TableProps.ColumnDefinition<Session>[]
                }
            />
            {renameSessionModal}
        </>
    );
}
