// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import {
    Alert,
    BreadcrumbGroup,
    Container,
    ContentLayout,
    Header,
    SpaceBetween,
} from "@cloudscape-design/components";
import { useTranslation } from "react-i18next";
import { CHATBOT_NAME } from "../common/constants";
import useOnFollow from "../common/hooks/use-on-follow";
import BaseAppLayout from "../components/base-app-layout";

export default function NotFound() {
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
                        {
                            text: "Not Found",
                            href: "/not-found",
                        },
                    ]}
                    expandAriaLabel="Show path"
                    ariaLabel="Breadcrumbs"
                />
            }
            content={
                <ContentLayout header={<Header variant="h1">404. Page Not Found</Header>}>
                    <SpaceBetween size="l">
                        <Container>
                            <Alert type="error" header="404. Page Not Found">
                                {t("COMMON.ERRORS.NOT_FOUND_MSG")}
                            </Alert>
                        </Container>
                    </SpaceBetween>
                </ContentLayout>
            }
        />
    );
}
