// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Badge,
    Box,
    Button,
    ButtonGroup,
    Header,
    Input,
    List,
    Modal,
    SpaceBetween,
    Spinner,
    StatusIndicator,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { DateTime } from "luxon";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Session } from "../../API";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import {
    deleteSession as deleteSessionMut,
    renameSession as renameSessionMut,
} from "../../graphql/mutations";
import { listSessions as listSessionQuery } from "../../graphql/queries";

/**
 * In-chat conversation history (T6 — Cloudscape "Conversational history" pattern).
 *
 * A lightweight, quick-resume view rendered inside an AppLayout drawer. It shares
 * the same data source and mutations as the full-page `/sessions` table, but groups
 * conversations by relative time (Today / Yesterday / Past 7 days / Older) and lets
 * the user resume, rename, or delete one without leaving the playground.
 */

type TimeGroupKey = "today" | "yesterday" | "pastWeek" | "older";

const GROUP_ORDER: TimeGroupKey[] = ["today", "yesterday", "pastWeek", "older"];
const GROUP_LABEL_KEY: Record<TimeGroupKey, string> = {
    today: "CHATBOT.PLAYGROUND.HISTORY_TODAY",
    yesterday: "CHATBOT.PLAYGROUND.HISTORY_YESTERDAY",
    pastWeek: "CHATBOT.PLAYGROUND.HISTORY_PAST_WEEK",
    older: "CHATBOT.PLAYGROUND.HISTORY_OLDER",
};

/** Bucket a session's start time into a relative time group. */
function timeGroup(startTime: string): TimeGroupKey {
    const dt = DateTime.fromJSDate(new Date(startTime));
    const now = DateTime.now();
    if (dt.hasSame(now, "day")) return "today";
    if (dt.hasSame(now.minus({ days: 1 }), "day")) return "yesterday";
    if (dt > now.minus({ days: 7 })) return "pastWeek";
    return "older";
}

/** A voice session persists every turn with a `voice-` prefixed messageId. */
function isVoiceSession(session: Session): boolean {
    const history = session.history?.filter((h) => h !== null) ?? [];
    return history.length > 0 && history.every((h) => h!.messageId?.startsWith("voice-"));
}

export default function ConversationHistory() {
    const appContext = useContext(AppContext);
    const navigate = useNavigate();
    const { t } = useTranslation("ACA");

    const [sessions, setSessions] = useState<Session[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | undefined>(undefined);

    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");

    const listSessions = useCallback(async () => {
        if (!appContext) return;
        const client = generateClient();
        try {
            setError(undefined);
            const result = await client.graphql({ query: listSessionQuery });
            setSessions(result.data!.listSessions);
        } catch (err) {
            console.log(Utils.getErrorMessage(err));
            setError(Utils.getErrorMessage(err));
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
    }, [appContext, listSessions]);

    const deleteSession = async (id: string) => {
        const client = generateClient();
        try {
            await client.graphql({ query: deleteSessionMut, variables: { id } });
            await listSessions();
        } catch (err) {
            console.error("Failed to delete session:", err);
        }
    };

    const submitRename = async () => {
        if (!renameId) return;
        const client = generateClient();
        try {
            await client.graphql({
                query: renameSessionMut,
                variables: { id: renameId, title: renameValue },
            });
            await listSessions();
        } catch (err) {
            console.error("Failed to rename session:", err);
        }
        setRenameId(null);
    };

    // Group sessions by relative time, newest first within each group.
    const grouped = useMemo(() => {
        const buckets: Record<TimeGroupKey, Session[]> = {
            today: [],
            yesterday: [],
            pastWeek: [],
            older: [],
        };
        for (const s of sessions) buckets[timeGroup(s.startTime)].push(s);
        for (const key of GROUP_ORDER) {
            buckets[key].sort(
                (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
            );
        }
        return buckets;
    }, [sessions]);

    const renderSessionItem = (session: Session) => {
        const isoTime = new Date(session.startTime).toISOString();
        const relative = DateTime.fromISO(isoTime).toRelative() ?? isoTime;
        const voice = isVoiceSession(session);
        const title = session.title || session.id;
        return {
            id: session.id,
            content: (
                <Button
                    variant="inline-link"
                    onClick={() => navigate(`/${session.id}`)}
                    ariaLabel={title}
                >
                    {title.length > 60 ? `${title.substring(0, 60)}…` : title}
                </Button>
            ),
            secondaryContent: (
                <SpaceBetween direction="horizontal" size="xs">
                    {/* Full ISO timestamp in the title attribute (never truncate without tooltip) */}
                    <span title={isoTime}>{relative}</span>
                    <Badge color={voice ? "blue" : "grey"}>
                        {voice
                            ? t("CHATBOT.PLAYGROUND.HISTORY_BADGE_VOICE")
                            : t("CHATBOT.PLAYGROUND.HISTORY_BADGE_TEXT")}
                    </Badge>
                </SpaceBetween>
            ),
            actions: (
                <ButtonGroup
                    variant="icon"
                    ariaLabel={title}
                    onItemClick={({ detail }) => {
                        if (detail.id === "rename") {
                            setRenameId(session.id);
                            setRenameValue(session.title ?? "");
                        }
                        if (detail.id === "delete") {
                            void deleteSession(session.id);
                        }
                    }}
                    items={[
                        {
                            type: "icon-button",
                            id: "rename",
                            iconName: "edit",
                            text: t("CHATBOT.PLAYGROUND.HISTORY_RENAME"),
                        },
                        {
                            type: "icon-button",
                            id: "delete",
                            iconName: "remove",
                            text: t("CHATBOT.PLAYGROUND.HISTORY_DELETE"),
                        },
                    ]}
                />
            ),
        };
    };

    return (
        <Box padding={{ horizontal: "m", vertical: "m" }}>
            <SpaceBetween direction="vertical" size="m">
                <Header
                    variant="h2"
                    counter={isLoading ? undefined : `(${sessions.length})`}
                    actions={
                        <Button
                            iconName="refresh"
                            variant="icon"
                            ariaLabel={t("CHATBOT.SESSIONS.REFRESH")}
                            disabled={isLoading}
                            onClick={async () => {
                                setIsLoading(true);
                                await listSessions();
                                setIsLoading(false);
                            }}
                        />
                    }
                >
                    {t("CHATBOT.PLAYGROUND.HISTORY_TITLE")}
                </Header>

                {error && <StatusIndicator type="error">{error}</StatusIndicator>}

                {isLoading ? (
                    <Spinner />
                ) : sessions.length === 0 ? (
                    <Box color="text-status-inactive">
                        {t("CHATBOT.PLAYGROUND.HISTORY_EMPTY")}
                    </Box>
                ) : (
                    GROUP_ORDER.filter((key) => grouped[key].length > 0).map((key) => (
                        <SpaceBetween key={key} direction="vertical" size="xs">
                            <Box variant="h4">{t(GROUP_LABEL_KEY[key])}</Box>
                            <List
                                items={grouped[key]}
                                ariaLabel={t(GROUP_LABEL_KEY[key])}
                                renderItem={renderSessionItem}
                            />
                        </SpaceBetween>
                    ))
                )}
            </SpaceBetween>

            <Modal
                visible={renameId !== null}
                onDismiss={() => setRenameId(null)}
                header={t("CHATBOT.PLAYGROUND.HISTORY_RENAME")}
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            <Button variant="link" onClick={() => setRenameId(null)}>
                                {t("CHATBOT.SESSIONS.CANCEL_BUTTON")}
                            </Button>
                            <Button variant="primary" onClick={submitRename}>
                                {t("CHATBOT.SESSIONS.OK_BUTTON")}
                            </Button>
                        </SpaceBetween>
                    </Box>
                }
            >
                <Input
                    value={renameValue}
                    onChange={({ detail }) => setRenameValue(detail.value)}
                />
            </Modal>
        </Box>
    );
}
