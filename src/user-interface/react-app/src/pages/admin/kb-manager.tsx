// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import { BreadcrumbGroup } from "@cloudscape-design/components";
import { useState } from "react";
import { CHATBOT_NAME } from "../../common/constants";
import KBManager from "../../components/admin/kb-manager";
import BaseAppLayout from "../../components/base-app-layout";

import useOnFollow from "../../common/hooks/use-on-follow";

export default function KnowledgeBaseManagerPage() {
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
                            text: "Knowledge Base Manager",
                            href: "/admin/knowledge-bases",
                        },
                    ]}
                />
            }
            content={<KBManager toolsOpen={true} />}
        />
    );
}
