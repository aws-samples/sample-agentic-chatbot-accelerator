/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
import { generateClient } from "aws-amplify/api";

import { Dispatch, SetStateAction, useRef, useState } from "react";
import { ChatBotHistoryItem, ChatBotMessageType, Reference } from "./types";

import Avatar from "@cloudscape-design/chat-components/avatar";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import { Button, ExpandableSection, Modal, SpaceBetween } from "@cloudscape-design/components";
import { useTranslation } from "react-i18next";
import { StorageHelper } from "../../common/helpers/storage-helper";
import { getPresignedUrl as getPresignedUrlQuery } from "../../graphql/queries";
import styles from "../../styles/chat.module.scss";
import MessageToolbox from "./chat-message-toolbox";
import MarkdownContent from "./side-view/markdown-content";
import ViewReference from "./side-view/reference";

export interface ChatMessageProps {
    message: ChatBotHistoryItem;
    sessionId: string;
    setAnnex: Dispatch<SetStateAction<React.ReactElement | null>>;
}

export default function ChatMessage(props: ChatMessageProps) {
    const messageRef = useRef<HTMLDivElement>(null);
    let content = "";
    const [selectedContent, setSelectedContent] = useState<{
        visible: boolean;
        content: string;
        title: string;
    }>({
        visible: false,
        content: "",
        title: "",
    });

    const [reasoningModalVisible, setReasoningModalVisible] = useState(false);

    const formatExecutionTime = (ms: number): string => {
        return `${(ms / 1000).toFixed(1)}s`;
    };

    const { t } = useTranslation("ACA");
    const client = generateClient();

    if (props.message.content && props.message.content.length > 0) {
        content = props.message.content;
        // console.log("References:");
        // console.log(props.message.references);
    } else if (props.message.tokens && props.message.tokens.length > 0) {
        let currentSequence: number | undefined = undefined;
        for (const token of props.message.tokens) {
            if (currentSequence === undefined || currentSequence + 1 == token.sequenceNumber) {
                currentSequence = token.sequenceNumber;
                content += token.value;
            }
        }
    }

    const [stepsExpanded, setStepsExpanded] = useState(false);

    const renderToolStepsRow = () => {
        if (
            !props.message.complete ||
            !props.message.toolActions ||
            props.message.toolActions.length === 0
        ) {
            return null;
        }

        const sortedActions = [...props.message.toolActions].sort(
            (a, b) => a.invocationNumber - b.invocationNumber,
        );
        const stepCount = sortedActions.length;

        return (
            <div style={{ marginBottom: "8px" }}>
                <Button
                    variant="inline-link"
                    onClick={() => setStepsExpanded(!stepsExpanded)}
                    ariaLabel={`${stepCount} agent steps`}
                >
                    <span style={{ fontSize: "11px", color: "#687078" }}>
                        🔧 Agent performed {stepCount} step{stepCount !== 1 ? "s" : ""}{" "}
                        {stepsExpanded ? "▼" : "▶"}
                    </span>
                </Button>
                {stepsExpanded && (
                    <div
                        style={{
                            marginTop: "8px",
                            padding: "8px 16px",
                            backgroundColor: "#f7f8f8",
                            borderRadius: "6px",
                            borderLeft: "3px solid #687078",
                        }}
                    >
                        <ul style={{ margin: 0, paddingLeft: "16px" }}>
                            {sortedActions.map((action) => (
                                <li
                                    key={action.invocationNumber}
                                    style={{
                                        fontSize: "11px",
                                        color: "#687078",
                                        marginBottom: "4px",
                                    }}
                                >
                                    {action.toolAction}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        );
    };

    const renderToolActionsInside = () => {
        // Only render inside the bubble during generation (not complete)
        if (
            props.message.complete ||
            !props.message.toolActions ||
            props.message.toolActions.length === 0
        ) {
            return null;
        }

        const sortedActions = [...props.message.toolActions].sort(
            (a, b) => a.invocationNumber - b.invocationNumber,
        );

        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    padding: "8px 12px",
                    backgroundColor: "#f2f3f3",
                    borderRadius: "8px",
                    marginBottom: "8px",
                }}
            >
                {sortedActions.map((action) => (
                    <div
                        key={action.invocationNumber}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            fontSize: "12px",
                            color: "#545b64",
                        }}
                    >
                        <span style={{ fontSize: "14px" }}>🔧</span>
                        <span>{action.toolAction}</span>
                    </div>
                ))}
            </div>
        );
    };

    const scrollToUserQuestion = () => {
        // Navigate to the user's question that triggered this AI response
        // SpaceBetween wraps each child in a container div, so we need to:
        // 1. Go up to the SpaceBetween wrapper (parent)
        // 2. Get the previous sibling (previous SpaceBetween wrapper)
        // 3. Get its first child (the actual message element)
        const spaceBetweenWrapper = messageRef.current?.parentElement;
        const previousWrapper = spaceBetweenWrapper?.previousElementSibling;
        const userQuestion = previousWrapper?.firstElementChild;

        if (userQuestion) {
            userQuestion.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            // Fallback to current message if no previous sibling
            messageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    return (
        <div className={styles.fullWidthBubble} ref={messageRef}>
            {props.message?.type === ChatBotMessageType.AI && (
                <ChatBubble
                    ariaLabel="Avatar of generative AI assistant"
                    type="incoming"
                    avatar={
                        <Avatar
                            ariaLabel="Avatar of generative AI assistant"
                            color="gen-ai"
                            iconName="gen-ai"
                            loading={content?.length === 0}
                        />
                    }
                >
                    {renderToolStepsRow()}
                    {renderToolActionsInside()}
                    {content && content.length > 0 ? (
                        <MarkdownContent content={content} setAnnex={props.setAnnex} />
                    ) : (
                        "Generating an answer..."
                    )}{" "}
                    {props.message.complete && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                marginTop: "8px",
                            }}
                        >
                            <MessageToolbox message={props.message} sessionId={props.sessionId} />
                            <Button
                                variant="icon"
                                iconName="angle-up"
                                onClick={scrollToUserQuestion}
                                ariaLabel="Scroll to question"
                            />
                            {props.message.reasoningContent && (
                                <Button
                                    variant="icon"
                                    iconName="suggestions-gen-ai"
                                    onClick={() => setReasoningModalVisible(true)}
                                    ariaLabel="View model reasoning"
                                >
                                    <span
                                        style={{
                                            fontSize: "16px",
                                            cursor: "pointer",
                                        }}
                                        title="View model reasoning"
                                    >
                                        💡
                                    </span>
                                </Button>
                            )}
                            {props.message.reasoningContent && props.message.executionTimeMs && (
                                <span style={{ color: "#5f6b7a", fontSize: "12px" }}>|</span>
                            )}
                            {props.message.executionTimeMs && (
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
                    {props.message.reasoningContent && (
                        <Modal
                            visible={reasoningModalVisible}
                            onDismiss={() => setReasoningModalVisible(false)}
                            header="Model Reasoning"
                            size="large"
                        >
                            <MarkdownContent
                                content={props.message.reasoningContent}
                                setAnnex={props.setAnnex}
                            />
                        </Modal>
                    )}
                    {props.message.references &&
                        JSON.parse(props.message.references).filter(
                            (ref: Reference) =>
                                ref.documentTitle &&
                                ref.documentTitle.trim() !== "" &&
                                ref.content &&
                                ref.content.trim() !== "",
                        ).length > 0 && (
                            <ExpandableSection headerText="Sources">
                                <ul>
                                    {JSON.parse(props.message.references).map(
                                        (reference: Reference) => (
                                            <li key={reference.referenceId}>
                                                <SpaceBetween direction="horizontal" size="xs">
                                                    {reference.uri?.startsWith("s3://") ? (
                                                        <Button
                                                            variant="link"
                                                            loading={false}
                                                            iconAlign="left"
                                                            onClick={async (event) => {
                                                                event.preventDefault();
                                                                try {
                                                                    if (
                                                                        reference.pageNumber &&
                                                                        isNaN(
                                                                            Number(
                                                                                reference.pageNumber,
                                                                            ),
                                                                        )
                                                                    ) {
                                                                        reference.pageNumber =
                                                                            undefined;
                                                                    }
                                                                    const response =
                                                                        await client.graphql({
                                                                            query: getPresignedUrlQuery,
                                                                            variables: {
                                                                                s3Uri: reference.uri,
                                                                                pageNumber:
                                                                                    reference.pageNumber,
                                                                            },
                                                                        });
                                                                    window.open(
                                                                        response.data
                                                                            .getPresignedUrl!,
                                                                        "_blank",
                                                                    );
                                                                } catch (error) {
                                                                    console.error(
                                                                        "Error generating presigned URL:",
                                                                        error,
                                                                    );
                                                                }
                                                            }}
                                                        >
                                                            [{reference.referenceId}]{" "}
                                                            {reference.documentTitle}
                                                            {reference.pageNumber &&
                                                                (reference.pageNumber as unknown as string) !==
                                                                    "None" &&
                                                                ` - page ${reference.pageNumber}`}{" "}
                                                        </Button>
                                                    ) : (
                                                        <Button
                                                            href={reference.uri}
                                                            external
                                                            iconAlign="left"
                                                            variant="link"
                                                        >
                                                            [{reference.referenceId}]{" "}
                                                            {reference.documentTitle}
                                                        </Button>
                                                    )}
                                                    <Button
                                                        variant="link"
                                                        onClick={() =>
                                                            setSelectedContent({
                                                                visible: true,
                                                                content: reference.content,
                                                                title: reference.documentTitle,
                                                            })
                                                        }
                                                    ></Button>
                                                    <Button
                                                        onClick={() => {
                                                            if (!props.setAnnex) return;
                                                            props.setAnnex(
                                                                <ViewReference
                                                                    content={reference.content}
                                                                    title={reference.documentTitle}
                                                                    onClose={() => {
                                                                        if (!props.setAnnex) return;
                                                                        props.setAnnex(null);
                                                                        console.log("clear annex");
                                                                    }}
                                                                />,
                                                            );
                                                        }}
                                                        variant="link"
                                                    >
                                                        {t("CHATBOT.PLAYGROUND.VIEW_CHUNK_MSG")}
                                                    </Button>
                                                </SpaceBetween>
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </ExpandableSection>
                        )}
                    <Modal
                        visible={selectedContent.visible}
                        onDismiss={() =>
                            setSelectedContent({
                                visible: false,
                                content: "",
                                title: "",
                            })
                        }
                        header={selectedContent.title}
                    >
                        {selectedContent.content}
                    </Modal>
                </ChatBubble>
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
