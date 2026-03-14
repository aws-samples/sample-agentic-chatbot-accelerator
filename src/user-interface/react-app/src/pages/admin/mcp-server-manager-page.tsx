// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------
import { BreadcrumbGroup, Header, HelpPanel, SpaceBetween } from "@cloudscape-design/components";
import { useState } from "react";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import McpServerManager from "../../components/admin/agent-core/mcp-server-manager";
import BaseAppLayout from "../../components/base-app-layout";

export default function McpServerManagerPage() {
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
                            text: "AgentCore Manager",
                            href: "/agent-core",
                        },
                        {
                            text: "MCP Servers",
                            href: "/agent-core/mcp-servers",
                        },
                    ]}
                />
            }
            info={
                <HelpPanel header={<Header variant="h3">MCP Server Registry</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        <div>
                            <h4>Overview</h4>
                            <p>
                                MCP (Model Context Protocol) servers provide additional tools and
                                capabilities that agents can use during conversations.
                            </p>
                        </div>
                        <div>
                            <h4>Actions</h4>
                            <ul>
                                <li>
                                    <strong>Register</strong> — Add a new MCP server (AgentCore
                                    Runtime, Gateway, or public endpoint)
                                </li>
                                <li>
                                    <strong>Delete</strong> — Remove a UI-registered server (only if
                                    not in use by any agent)
                                </li>
                                <li>
                                    <strong>Used By</strong> — Shows which agents reference each
                                    server in their latest configuration
                                </li>
                            </ul>
                        </div>
                        <div>
                            <h4>Tips</h4>
                            <ul>
                                <li>
                                    Use SigV4 authentication for AgentCore-hosted servers (Runtime
                                    or Gateway)
                                </li>
                                <li>
                                    Only use &quot;None&quot; auth for trusted, read-only public
                                    endpoints
                                </li>
                                <li>
                                    CDK-managed servers cannot be deleted from the UI — update your
                                    infrastructure config instead
                                </li>
                            </ul>
                        </div>
                    </SpaceBetween>
                </HelpPanel>
            }
            toolsWidth={300}
            content={<McpServerManager toolsOpen={toolsOpen} />}
        />
    );
}
