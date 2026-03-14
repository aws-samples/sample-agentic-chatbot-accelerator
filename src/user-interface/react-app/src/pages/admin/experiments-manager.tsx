// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { BreadcrumbGroup, Header, HelpPanel, SpaceBetween } from "@cloudscape-design/components";
import { useState } from "react";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import ExperimentsManager from "../../components/admin/experiments-manager";
import BaseAppLayout from "../../components/base-app-layout";

export default function ExperimentsManagerPage() {
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
                            text: "Experiments",
                            href: "/experiments",
                        },
                    ]}
                />
            }
            info={
                <HelpPanel header={<Header variant="h3">Experiments Guide</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        <div>
                            <h4>Overview</h4>
                            <ul>
                                <li>Create experiments to test your agent's performance</li>
                                <li>Define test cases with expected outputs</li>
                            </ul>
                        </div>
                        <div>
                            <h4>Actions</h4>
                            <ul>
                                <li>Create new experiments with test cases</li>
                                <li>Generate synthetic test cases from context</li>
                                <li>Compare performance across runs</li>
                            </ul>
                        </div>
                        <div>
                            <h4>Tips</h4>
                            <ul>
                                <li>Start with a small set of test cases</li>
                                <li>Review failed cases to improve your agent</li>
                            </ul>
                        </div>
                    </SpaceBetween>
                </HelpPanel>
            }
            toolsWidth={300}
            content={<ExperimentsManager />}
        />
    );
}
