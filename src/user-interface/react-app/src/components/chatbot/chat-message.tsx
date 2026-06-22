// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";

import React, { Dispatch, SetStateAction, useRef } from "react";
import { ChatBotHistoryItem, ChatBotMessageType, Reference, ToolActionItem } from "./types";

import Avatar from "@cloudscape-design/chat-components/avatar";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import {
    Box,
    Button,
    ExpandableSection,
    Icon,
    Link,
    SpaceBetween,
    Steps,
    StatusIndicatorProps,
} from "@cloudscape-design/components";
import { useTranslation } from "react-i18next";
import { StorageHelper } from "../../common/helpers/storage-helper";
import { getPresignedUrl as getPresignedUrlQuery } from "../../graphql/queries";
import styles from "../../styles/chat.module.scss";
import MessageToolbox from "./chat-message-toolbox";
import { humanizeToolName, maskSensitiveInfo } from "./utils";
import MarkdownContent from "./side-view/markdown-content";
import ViewReference from "./side-view/reference";
import StructuredOutputView from "./side-view/structured-output-view";

export interface ChatMessageProps {
    message: ChatBotHistoryItem;
    sessionId: string;
    setAnnex: Dispatch<SetStateAction<React.ReactElement | null>>;
    /** Replay the originating prompt for this response (only set on the last AI message). */
    onRegenerate?: () => void;
    /** Whether regeneration is currently allowed (disabled mid-generation). */
    canRegenerate?: boolean;
}

export default function ChatMessage(props: ChatMessageProps) {
    const messageRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation("ACA");
    const client = generateClient();

    let content = "";

    const formatExecutionTime = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

    if (props.message.content && props.message.content.length > 0) {
        content = props.message.content;
    } else if (props.message.tokens && props.message.tokens.length > 0) {
        let currentSequence: number | undefined = undefined;
        for (const token of props.message.tokens) {
            if (currentSequence === undefined || currentSequence + 1 == token.sequenceNumber) {
                currentSequence = token.sequenceNumber;
                content += token.value;
            }
        }
    }

    const isGenerating = props.message?.type === ChatBotMessageType.AI && !props.message.complete;
    const hasNoContent = !content || content.length === 0;

    /**
     * Header label prefixed with an icon, so the "process" sections (Thinking / Steps)
     * read as distinct from the final answer that follows the divider below them.
     */
    const iconHeader = (iconName: "suggestions-gen-ai" | "settings", label: string) => (
        <Box fontSize="body-s" color="text-status-inactive">
            <SpaceBetween direction="horizontal" size="xxs" alignItems="center">
                <Icon name={iconName} variant="subtle" size="small" />
                <span>{label}</span>
            </SpaceBetween>
        </Box>
    );

    // ================================================================
    // T1 — Progressive steps for tool actions
    // ================================================================

    /** Compact, dimmed name/value rendering for a step's arguments (masked for display). */
    const renderStepDetails = (action: ToolActionItem): React.ReactNode | undefined => {
        if (!action.parameters || action.parameters.length === 0) return undefined;
        return (
            <Box fontSize="body-s" color="text-status-inactive">
                {action.parameters.map((p) => (
                    <div key={p.name} style={{ wordBreak: "break-word" }}>
                        <b>{p.name}:</b> {maskSensitiveInfo(p.value)}
                    </div>
                ))}
            </Box>
        );
    };

    const buildSteps = (actions: ToolActionItem[]) =>
        actions.map((action) => {
            // Records that predate the status field have no status — treat as success.
            const status: StatusIndicatorProps.Type =
                action.status === "running"
                    ? "loading"
                    : action.status === "error"
                      ? "error"
                      : "success";
            return {
                status,
                header: humanizeToolName(action.toolName),
                details: renderStepDetails(action),
            };
        });

    const sortedToolActions = props.message.toolActions
        ? [...props.message.toolActions].sort((a, b) => a.invocationNumber - b.invocationNumber)
        : [];
    const hasToolActions = sortedToolActions.length > 0;

    const renderSteps = () => {
        if (!hasToolActions) return null;
        const steps = buildSteps(sortedToolActions);

        // During generation: show the live Steps inline under an icon-prefixed label.
        // On completion: collapse the sequence into a default-collapsed
        // ExpandableSection (per the docs), with the same icon header.
        if (isGenerating) {
            return (
                <SpaceBetween direction="vertical" size="xs">
                    {iconHeader("settings", t("CHATBOT.PLAYGROUND.STEPS_HEADER"))}
                    <div className={styles.stepsContent}>
                        <Steps steps={steps} ariaLabel={t("CHATBOT.PLAYGROUND.STEPS_HEADER")} />
                    </div>
                </SpaceBetween>
            );
        }
        return (
            <ExpandableSection
                variant="footer"
                headerText={iconHeader(
                    "settings",
                    t("CHATBOT.PLAYGROUND.STEPS_PERFORMED", {
                        count: sortedToolActions.length,
                    }),
                )}
            >
                <div className={styles.stepsContent}>
                    <Steps steps={steps} ariaLabel={t("CHATBOT.PLAYGROUND.STEPS_HEADER")} />
                </div>
            </ExpandableSection>
        );
    };

    // ================================================================
    // T5 — Artifact previews (structured output + sources)
    // ================================================================

    const openStructuredOutputCanvas = () => {
        if (!props.setAnnex || !props.message.structuredOutput) return;
        props.setAnnex(
            <StructuredOutputView
                raw={props.message.structuredOutput}
                title={t("CHATBOT.PLAYGROUND.STRUCTURED_OUTPUT_LABEL")}
                onClose={() => props.setAnnex(null)}
            />,
        );
    };

    const openReferenceCanvas = (reference: Reference) => {
        if (!props.setAnnex) return;
        props.setAnnex(
            <ViewReference
                content={reference.content}
                title={reference.documentTitle}
                onClose={() => props.setAnnex(null)}
            />,
        );
    };

    const openPresignedSource = async (reference: Reference) => {
        try {
            if (reference.pageNumber && isNaN(Number(reference.pageNumber))) {
                reference.pageNumber = undefined;
            }
            const response = await client.graphql({
                query: getPresignedUrlQuery,
                variables: { s3Uri: reference.uri, pageNumber: reference.pageNumber },
            });
            window.open(response.data.getPresignedUrl!, "_blank");
        } catch (error) {
            console.error("Error generating presigned URL:", error);
        }
    };

    const renderSources = () => {
        if (!props.message.references) return null;
        let parsed: Reference[];
        try {
            parsed = JSON.parse(props.message.references);
        } catch {
            return null;
        }
        const sources = parsed.filter(
            (ref) =>
                ref.documentTitle &&
                ref.documentTitle.trim() !== "" &&
                ref.content &&
                ref.content.trim() !== "",
        );
        if (sources.length === 0) return null;

        return (
            <ExpandableSection
                variant="footer"
                headerText={t("CHATBOT.PLAYGROUND.SOURCES_LABEL")}
            >
                <SpaceBetween direction="vertical" size="xs">
                    {sources.map((reference) => {
                        const hasPage =
                            reference.pageNumber &&
                            (reference.pageNumber as unknown as string) !== "None";
                        const label = `[${reference.referenceId}] ${reference.documentTitle}${
                            hasPage ? ` - page ${reference.pageNumber}` : ""
                        }`;
                        return (
                            <SpaceBetween
                                key={reference.referenceId}
                                direction="horizontal"
                                size="xs"
                            >
                                {reference.uri?.startsWith("s3://") ? (
                                    <Link
                                        onFollow={(e) => {
                                            e.preventDefault();
                                            void openPresignedSource(reference);
                                        }}
                                    >
                                        {label}
                                    </Link>
                                ) : (
                                    <Link href={reference.uri} external>
                                        {label}
                                    </Link>
                                )}
                                <Button
                                    variant="inline-link"
                                    iconName="external"
                                    onClick={() => openReferenceCanvas(reference)}
                                >
                                    {t("CHATBOT.PLAYGROUND.VIEW_CHUNK_MSG")}
                                </Button>
                            </SpaceBetween>
                        );
                    })}
                </SpaceBetween>
            </ExpandableSection>
        );
    };

    const scrollToUserQuestion = () => {
        // Navigate to the user's question that triggered this AI response.
        // SpaceBetween wraps each child in a container div, so step up to the wrapper,
        // take the previous sibling, then its first child (the actual message element).
        const spaceBetweenWrapper = messageRef.current?.parentElement;
        const previousWrapper = spaceBetweenWrapper?.previousElementSibling;
        const userQuestion = previousWrapper?.firstElementChild;

        if (userQuestion) {
            userQuestion.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            messageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    return (
        <div className={styles.fullWidthBubble} ref={messageRef}>
            {props.message?.type === ChatBotMessageType.AI && (
                <SpaceBetween direction="vertical" size="s">
                    <ChatBubble
                        ariaLabel="Avatar of generative AI assistant"
                        type="incoming"
                        showLoadingBar={isGenerating}
                        avatar={
                            <Avatar
                                ariaLabel="Avatar of generative AI assistant"
                                color="gen-ai"
                                iconName="gen-ai"
                                loading={isGenerating && hasNoContent}
                            />
                        }
                    >
                        {/* T2 — Thinking: collapsed reasoning inline, above the answer */}
                        {props.message.reasoningContent && (
                            <ExpandableSection
                                variant="footer"
                                headerText={iconHeader(
                                    "suggestions-gen-ai",
                                    isGenerating
                                        ? t("CHATBOT.PLAYGROUND.THINKING_ACTIVE")
                                        : t("CHATBOT.PLAYGROUND.THINKING_LABEL"),
                                )}
                            >
                                <div className={styles.reasoningContent}>
                                    <MarkdownContent
                                        content={props.message.reasoningContent}
                                        setAnnex={props.setAnnex}
                                    />
                                </div>
                            </ExpandableSection>
                        )}

                        {/* T1 — Progressive steps */}
                        {renderSteps()}

                        {/* T7 — answer body / processing label */}
                        {content && content.length > 0 ? (
                            <MarkdownContent content={content} setAnnex={props.setAnnex} />
                        ) : (
                            <Box color="text-status-inactive">
                                {t("CHATBOT.PLAYGROUND.GENERATING_RESPONSE")}
                            </Box>
                        )}

                        {props.message.complete && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    marginTop: "8px",
                                }}
                            >
                                <MessageToolbox
                                    message={props.message}
                                    sessionId={props.sessionId}
                                    onRegenerate={props.onRegenerate}
                                    canRegenerate={props.canRegenerate}
                                    onViewStructuredOutput={
                                        props.message.structuredOutput
                                            ? openStructuredOutputCanvas
                                            : undefined
                                    }
                                />
                                <Button
                                    variant="icon"
                                    iconName="angle-up"
                                    onClick={scrollToUserQuestion}
                                    ariaLabel="Scroll to question"
                                />
                                {props.message.executionTimeMs != null && (
                                    <span
                                        style={{
                                            fontSize: "12px",
                                            color: "#5f6b7a",
                                            fontWeight: 400,
                                        }}
                                    >
                                        {formatExecutionTime(props.message.executionTimeMs)}
                                    </span>
                                )}
                            </div>
                        )}
                    </ChatBubble>

                    {/* T5 — sources stacked below the bubble (structured output opens
                        in the annex canvas from the message toolbox). */}
                    {renderSources()}
                </SpaceBetween>
            )}

            {props.message?.type === ChatBotMessageType.Human && (
                <ChatBubble
                    ariaLabel="User"
                    type="outgoing"
                    avatar={
                        <Avatar
                            ariaLabel={StorageHelper.getUserName()}
                            tooltipText={StorageHelper.getUserName()}
                            initials={StorageHelper.getUserInitials()}
                        />
                    }
                >
                    <MarkdownContent content={props.message.content} setAnnex={props.setAnnex} />
                </ChatBubble>
            )}
        </div>
    );
}
