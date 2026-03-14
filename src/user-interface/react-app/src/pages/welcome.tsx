// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import BaseAppLayout from "../components/base-app-layout";

import {
    BreadcrumbGroup,
    Container,
    ContentLayout,
    Header,
    SpaceBetween,
} from "@cloudscape-design/components";
import { useTranslation } from "react-i18next";
import { CHATBOT_NAME } from "../common/constants";
import useOnFollow from "../common/hooks/use-on-follow";
import RouterButton from "../components/wrappers/router-button";

export default function Welcome() {
    const onFollow = useOnFollow();
    const { t } = useTranslation("ACA");

    return (
        <BaseAppLayout
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        {
                            text: CHATBOT_NAME,
                            href: "/",
                        },
                    ]}
                />
            }
            content={
                <ContentLayout
                    header={
                        <Header
                            variant="h1"
                            data-locator="welcome-header"
                            description="Agentic Chatbot Accelerator"
                            actions={
                                <RouterButton
                                    iconAlign="right"
                                    iconName="contact"
                                    variant="primary"
                                    href="/chatbot/agent-chat"
                                >
                                    {t("COMMON.INFO.GET_STARTED_MSG")}
                                </RouterButton>
                            }
                        >
                            {t("COMMON.INFO.HOME_BUTTON")}
                        </Header>
                    }
                >
                    {" "}
                    <SpaceBetween size="l">
                        <Container
                            media={{
                                content: <img src="/images/amazon-bedrock.png" alt="placeholder" />,
                                width: 250,
                                position: "side",
                            }}
                        >
                            <Header variant="h1" description="AWS Generative AI Innovation Center">
                                {t("COMMON.INFO.APP_DESCRIPTION")}
                            </Header>
                            <p>{t("COMMON.INFO.DUMMY_MSG")}</p>
                        </Container>
                    </SpaceBetween>
                </ContentLayout>
            }
        />
    );
}
