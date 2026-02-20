/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    ...
*/
import { Icon, SideNavigation, SideNavigationProps } from "@cloudscape-design/components";
import { useContext, useMemo } from "react";
import { AppContext } from "../common/app-context";
import { CHATBOT_NAME } from "../common/constants";
import { useNavigationPanelState } from "../common/hooks/use-navigation-panel-state";
import useOnFollow from "../common/hooks/use-on-follow";

export default function NavigationPanel() {
    const onFollow = useOnFollow();
    const appContext = useContext(AppContext);
    const [navigationPanelState, setNavigationPanelState] = useNavigationPanelState();
    const items = useMemo<SideNavigationProps.Item[]>(() => {
        const baseItems: SideNavigationProps.Item[] = [
            { type: "link", text: "Agent Chat", href: "/", info: <Icon name="gen-ai" /> },
            {
                type: "link",
                text: "User Sessions",
                href: "/sessions",
                info: <Icon name="list-view" />,
            },
            { type: "divider" },
            {
                type: "link",
                text: "AgentCore Endpoint Manager",
                href: "/agent-core",
                info: <Icon name="user-profile" />,
            },
        ];

        // Only add Document Manager and Knowledge Base Manager if knowledge base is supported
        if (appContext?.knowledgeBaseIsSupported) {
            baseItems.push(
                {
                    type: "link",
                    text: "Document Manager",
                    href: "/documents",
                    info: <Icon name="folder-open" />,
                },
                {
                    type: "link",
                    text: "Knowledge Base Manager",
                    href: "/knowledgebase",
                    info: <Icon name="file" />,
                },
            );
        }

        baseItems.push(
            { type: "divider" },
            {
                type: "link",
                text: "Team",
                href: "https://aws.amazon.com/ai/generative-ai/innovation-center/",
                external: true,
            },
        );

        return baseItems;
    }, [appContext?.knowledgeBaseIsSupported]);

    // onChange - updates `navigationPanelState`
    const onChange = ({ detail }: { detail: SideNavigationProps.ChangeDetail }) => {
        const sectionIndex = items.indexOf(detail.item);
        setNavigationPanelState({
            collapsedSections: {
                ...navigationPanelState.collapsedSections,
                [sectionIndex]: !detail.expanded,
            },
        });
    };

    // Rendering
    return (
        <SideNavigation
            onFollow={onFollow}
            onChange={onChange}
            header={{ href: "/", text: CHATBOT_NAME }}
            items={items.map((value, idx) => {
                if (value.type === "section") {
                    const collapsed = navigationPanelState.collapsedSections?.[idx] === true;
                    value.defaultExpanded = !collapsed;
                }
                return value;
            })}
        />
    );
}
