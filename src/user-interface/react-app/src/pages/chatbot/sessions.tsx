/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    ...
*/

import { BreadcrumbGroup } from "@cloudscape-design/components";
import { useState } from "react";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import BaseAppLayout from "../../components/base-app-layout";
import Sessions from "../../components/chatbot/sessions";

export default function SessionPage() {
    const [toolsOpen, setToolsOpen] = useState(false);
    const onFollow = useOnFollow();

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
                            text: "Sessions",
                            href: "/chatbot/sessions",
                        },
                    ]}
                />
            }
            content={<Sessions toolsOpen={true} />}
        />
    );
}
