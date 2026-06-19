// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Header, HelpPanel, SpaceBetween } from "@cloudscape-design/components";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import BaseAppLayout from "../../components/base-app-layout";
import Chat from "../../components/chatbot/chat";
import ConversationHistory from "../../components/chatbot/conversation-history";

export default function Playground() {
    const { sessionId } = useParams();
    const { t } = useTranslation("ACA");
    const navigate = useNavigate();

    return (
        <BaseAppLayout
            drawerAction={{
                id: "new-thread",
                ariaLabel: "Start new chat",
                iconName: "add-plus",
                onClick: () => navigate(`/${uuidv4()}`),
            }}
            info={
                <HelpPanel
                    header={<Header variant="h3">{t("CHATBOT.PLAYGROUND.USER_GUIDE_MSG")}</Header>}
                >
                    <SpaceBetween direction="vertical" size="l">
                        <div>
                            <h4>{t("CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_TITLE")}</h4>
                            <ul>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_1")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_2")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_3")}</li>
                            </ul>
                        </div>
                        <div>
                            <h4>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_TITLE")}</h4>
                            <ul>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_1")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_2")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_3")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_4")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_FEATURES_5")}</li>
                            </ul>
                        </div>
                        <div>
                            <h4>{t("CHATBOT.PLAYGROUND.HELP_TIPS_TITLE")}</h4>
                            <ul>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_TIPS_1")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_TIPS_2")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_TIPS_3")}</li>
                                <li>{t("CHATBOT.PLAYGROUND.HELP_TIPS_4")}</li>
                            </ul>
                        </div>
                    </SpaceBetween>
                </HelpPanel>
            }
            customDrawers={[
                {
                    id: "conversation-history",
                    ariaLabels: {
                        drawerName: t("CHATBOT.PLAYGROUND.HISTORY_DRAWER_ARIA"),
                        triggerButton: t("CHATBOT.PLAYGROUND.HISTORY_TITLE"),
                        closeButton: t("CHATBOT.SESSIONS.CANCEL_BUTTON"),
                    },
                    trigger: { iconName: "history" },
                    content: <ConversationHistory />,
                    resizable: true,
                    defaultSize: 360,
                },
            ]}
            toolsWidth={300}
            maxContentWidth={10000}
            content={<Chat sessionId={sessionId} />}
        />
    );
}
