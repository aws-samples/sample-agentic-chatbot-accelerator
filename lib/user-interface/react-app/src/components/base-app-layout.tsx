// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import type { AppLayoutProps as AppLayoutPropsType } from "@cloudscape-design/components";
import { AppLayout, AppLayoutProps } from "@cloudscape-design/components";
import type { IconProps } from "@cloudscape-design/components/icon";
import { ReactElement, useState } from "react";
import { useNavigationPanelState } from "../common/hooks/use-navigation-panel-state";
import NavigationPanel from "./navigation-panel";

interface DrawerActionConfig {
    id: string;
    ariaLabel: string;
    iconName?: IconProps.Name;
    iconSvg?: ReactElement;
    onClick: () => void;
}

interface BaseAppLayoutProps extends AppLayoutProps {
    info?: ReactElement;
    customDrawers?: AppLayoutPropsType.Drawer[];
    drawerAction?: DrawerActionConfig;
}

export default function BaseAppLayout(props: BaseAppLayoutProps) {
    const [navigationPanelState, setNavigationPanelState] = useNavigationPanelState();
    const [activeDrawerId, setActiveDrawerId] = useState<string | null>(null);
    const { customDrawers, drawerAction, info, ...appLayoutProps } = props;

    // Build drawers array - combine action drawer, info drawer, and custom drawers
    const allDrawers: AppLayoutPropsType.Drawer[] = [];

    // Add action drawer first (appears at top)
    if (drawerAction) {
        allDrawers.push({
            id: drawerAction.id,
            ariaLabels: {
                drawerName: drawerAction.ariaLabel,
                triggerButton: drawerAction.ariaLabel,
            },
            trigger: {
                iconName: drawerAction.iconName,
                iconSvg: drawerAction.iconSvg,
            },
            content: <></>, // Empty content since we intercept the click
        });
    }

    // Add info drawer if info content is provided
    if (info) {
        allDrawers.push({
            id: "info",
            ariaLabels: {
                drawerName: "Info",
                closeButton: "Close info",
                triggerButton: "Open info",
            },
            trigger: {
                iconName: "status-info",
            },
            content: info,
        });
    }

    if (customDrawers) {
        allDrawers.push(...customDrawers);
    }

    const handleDrawerChange = (event: { detail: { activeDrawerId: string | null } }) => {
        // If the action drawer was clicked, trigger the action instead of opening
        if (drawerAction && event.detail.activeDrawerId === drawerAction.id) {
            drawerAction.onClick();
            return; // Don't let it open
        }
        setActiveDrawerId(event.detail.activeDrawerId);
    };

    return (
        <AppLayout
            headerSelector="#awsui-top-navigation"
            navigation={<NavigationPanel />}
            navigationOpen={!navigationPanelState.collapsed}
            onNavigationChange={({ detail }) =>
                setNavigationPanelState({ collapsed: !detail.open })
            }
            drawers={allDrawers.length > 0 ? allDrawers : undefined}
            activeDrawerId={activeDrawerId}
            onDrawerChange={handleDrawerChange}
            {...appLayoutProps}
        />
    );
}
