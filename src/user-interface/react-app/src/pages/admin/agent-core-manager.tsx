// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import { BreadcrumbGroup, Header, HelpPanel, SpaceBetween } from "@cloudscape-design/components";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import AgentCoreEndpointManager from "../../components/admin/agent-core-runtime-manager";
import BaseAppLayout from "../../components/base-app-layout";

export default function AgentCoreManagerPage() {
    const [toolsOpen, setToolsOpen] = useState(false);
    const onFollow = useOnFollow();
    const { t } = useTranslation("ACA");

    return (
        <BaseAppLayout
            contentType="table"
            toolsOpen={toolsOpen}
            onToolsChange={(e) => setToolsOpen(e.detail.open)}
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        {
                            text: CHATBOT_NAME,
                            href: "/",
                        },
                        {
                            text: "AgentCore Manager",
                            href: "/agent-core",
                        },
                    ]}
                />
            }
            info={
                <HelpPanel
                    header={<Header variant="h3">{t("ADMIN.AGENTCORE.USER_GUIDE_MSG")}</Header>}
                >
                    <SpaceBetween direction="vertical" size="l">
                        <div>
                            <h4>{t("ADMIN.AGENTCORE.HELP_OVERVIEW_TITLE")}</h4>
                            <ul>
                                <li>{t("ADMIN.AGENTCORE.HELP_OVERVIEW_1")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_OVERVIEW_2")}</li>
                            </ul>
                        </div>
                        <div>
                            <h4>{t("ADMIN.AGENTCORE.HELP_ACTIONS_TITLE")}</h4>
                            <ul>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_1")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_2")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_3")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_4")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_5")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_ACTIONS_6")}</li>
                            </ul>
                        </div>
                        <div>
                            <h4>{t("ADMIN.AGENTCORE.HELP_TIPS_TITLE")}</h4>
                            <ul>
                                <li>{t("ADMIN.AGENTCORE.HELP_TIPS_1")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_TIPS_2")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_TIPS_3")}</li>
                                <li>{t("ADMIN.AGENTCORE.HELP_TIPS_4")}</li>
                            </ul>
                        </div>
                    </SpaceBetween>
                </HelpPanel>
            }
            toolsWidth={300}
            content={<AgentCoreEndpointManager toolsOpen={true} />}
        />
    );
}
