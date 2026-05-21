// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------
import { BreadcrumbGroup, Header, HelpPanel, SpaceBetween } from "@cloudscape-design/components";
import { useState } from "react";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import SkillManager from "../../components/admin/skill-manager";
import BaseAppLayout from "../../components/base-app-layout";

export default function SkillManagerPage() {
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
                            text: "Skills",
                            href: "/agent-core/skills",
                        },
                    ]}
                />
            }
            info={
                <HelpPanel header={<Header variant="h3">Agent Skills</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        <div>
                            <h4>Overview</h4>
                            <p>
                                Skills give agents on-demand access to specialized instructions
                                without bloating the system prompt. Instead of front-loading every
                                possible instruction, you define modular skill packages that the
                                agent discovers and activates only when relevant.
                            </p>
                        </div>
                        <div>
                            <h4>How Skills Work</h4>
                            <ul>
                                <li>
                                    <strong>Discovery</strong> — Skill names and descriptions are
                                    injected into the system prompt
                                </li>
                                <li>
                                    <strong>Activation</strong> — The agent calls a{" "}
                                    <code>skills</code> tool to load full instructions on-demand
                                </li>
                                <li>
                                    <strong>Execution</strong> — The agent follows the loaded
                                    instructions for the conversation
                                </li>
                            </ul>
                        </div>
                        <div>
                            <h4>Actions</h4>
                            <ul>
                                <li>
                                    <strong>Create</strong> — Add a new skill with a name,
                                    description, and markdown instructions
                                </li>
                                <li>
                                    <strong>Edit</strong> — Update a skill&apos;s description or
                                    instructions
                                </li>
                                <li>
                                    <strong>Delete</strong> — Remove a skill from the system
                                </li>
                            </ul>
                        </div>
                        <div>
                            <h4>Tips</h4>
                            <ul>
                                <li>
                                    Keep descriptions concise — they appear in the agent&apos;s
                                    system prompt
                                </li>
                                <li>
                                    Use markdown formatting in instructions for clarity
                                </li>
                                <li>
                                    Attach skills to agents in the agent wizard (&quot;Tools &amp;
                                    Skills&quot; step)
                                </li>
                            </ul>
                        </div>
                    </SpaceBetween>
                </HelpPanel>
            }
            toolsWidth={300}
            content={<SkillManager />}
        />
    );
}
