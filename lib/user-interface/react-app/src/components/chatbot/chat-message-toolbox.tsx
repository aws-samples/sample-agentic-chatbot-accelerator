// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Button,
    ButtonGroup,
    Container,
    FormField,
    SpaceBetween,
    StatusIndicator,
    Textarea,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useState } from "react";
import { publishFeedback as publishFeedbackMut } from "../../graphql/mutations";
import { ChatBotHistoryItem } from "./types";

export interface MessageToolboxProps {
    message: ChatBotHistoryItem;
    sessionId: string;
}

export default function MessageToolbox(props: MessageToolboxProps) {
    // ===============================================================
    //                        Feedback
    // ===============================================================
    const client = generateClient();

    const [sentiment, setSentiment] = useState(props.message?.feedback?.sentiment || "");
    const [notes, setNotes] = useState(props.message?.feedback?.notes || "");
    const [showNotes, setShowNotes] = useState(false);

    const saveSentiment = (new_sentiment: string) => {
        console.log("@saveSentiment start");
        if (!props.message.feedback) {
            props.message.feedback = { sentiment: "", notes: "" };
        }

        props.message.feedback.sentiment = new_sentiment;
        publishFeedback();
        console.log("@saveSentiment successful");
    };

    const saveNotes = async () => {
        console.log("@saveNotes start");

        // Ensure feedback object exists
        if (!props.message.feedback) {
            props.message.feedback = { sentiment: "", notes: "" };
        }

        // Update the message object directly
        props.message.feedback.notes = notes;

        publishFeedback();
        console.log("@saveNotes successful");
    };

    const publishFeedback = async () => {
        console.log("@publishFeedback start");
        let mutationSuccessful = false;

        try {
            const response = await client.graphql({
                query: publishFeedbackMut,
                variables: {
                    feedback: JSON.stringify({ ...props.message.feedback }),
                    messageId: props.message.messageId,
                    messageType: props.message.type,
                    sessionId: props.sessionId,
                },
            });

            mutationSuccessful = response.data.publishFeedback;

            if (!mutationSuccessful) {
                console.error("Feedback sentiment sending failed");
            }
        } catch (err) {
            console.error("Mutation error:", err);
        }
        console.log("@publishFeedback successful");
    };

    return (
        <SpaceBetween size="s">
            <SpaceBetween direction="horizontal" size="s">
                <ButtonGroup
                    onItemClick={({ detail }) => {
                        ["showFeedbackToggle"].includes(detail.id) &&
                            setShowNotes((state) => !state);

                        if (["like", "dislike"].includes(detail.id)) {
                            const new_sentiment = detail.pressed ? detail.id : "";
                            setShowNotes(true);
                            setSentiment(new_sentiment);
                            saveSentiment(new_sentiment);
                        }
                        if (detail.id === "copy") {
                            navigator.clipboard.writeText(props.message.content).catch((err) => {
                                console.error("Failed to copy text: ", err);
                            });
                        }
                    }}
                    ariaLabel="Chat actions"
                    items={[
                        {
                            type: "group",
                            text: "Vote",
                            items: [
                                {
                                    type: "icon-toggle-button",
                                    id: "like",
                                    iconName: "thumbs-up",
                                    pressedIconName: "thumbs-up-filled",
                                    text: "Like",
                                    pressed: sentiment === "like",
                                },
                                {
                                    type: "icon-toggle-button",
                                    id: "dislike",
                                    iconName: "thumbs-down",
                                    pressedIconName: "thumbs-down-filled",
                                    text: "Dislike",
                                    pressed: sentiment === "dislike",
                                },
                                {
                                    type: "icon-button",
                                    id: "showFeedbackToggle",
                                    iconName: showNotes ? "angle-up" : "angle-down",
                                    text: "Additional Feedback",
                                },
                            ],
                        },
                        {
                            type: "group",
                            text: "copy",
                            items: [
                                {
                                    type: "icon-button",
                                    id: "copy",
                                    iconName: "copy",
                                    text: "Copy",
                                    popoverFeedback: (
                                        <StatusIndicator type="success">
                                            Message copied
                                        </StatusIndicator>
                                    ),
                                },
                            ],
                        },
                        {
                            type: "group",
                            text: "empty",
                            items: [],
                        },
                    ]}
                    variant="icon"
                />
            </SpaceBetween>
            {showNotes && (
                <SpaceBetween size="s" direction="horizontal">
                    <Container>
                        <FormField
                            label={
                                <span>
                                    Additional notes - <i>optional</i>
                                </span>
                            }
                            stretch={true}
                            constraintText="Do not disclose any personal, commercially sensitive, or confidential information."
                        >
                            <Textarea
                                value={notes}
                                onChange={({ detail }) => setNotes(detail.value)}
                            />
                        </FormField>
                    </Container>
                    <SpaceBetween size="s" direction="vertical">
                        <Button
                            iconName="close"
                            variant="icon"
                            onClick={() => {
                                setShowNotes(false);
                            }}
                        />
                        <Button
                            iconName="send"
                            variant="icon"
                            onClick={() => {
                                setShowNotes(false);
                                saveNotes();
                            }}
                        />
                    </SpaceBetween>
                </SpaceBetween>
            )}
        </SpaceBetween>
    );
}
