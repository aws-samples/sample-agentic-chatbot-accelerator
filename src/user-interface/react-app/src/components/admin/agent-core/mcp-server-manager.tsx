// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------
import {
    Box,
    Button,
    Container,
    Header,
    Popover,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { generateClient } from "aws-amplify/api";
import { McpServer, ResponseStatus } from "../../../API";
import { deleteMcpServer as deleteMcpServerMutation } from "../../../graphql/mutations";
import {
    getRuntimeConfigurationByVersion as getRuntimeConfigurationByVersionQuery,
    listAgentVersions as listAgentVersionsQuery,
    listAvailableMcpServers as listAvailableMcpServersQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../../graphql/queries";
import { RegisterMcpServerModal } from "../../wizard/register-mcp-server-modal";

export interface McpServerManagerProps {
    readonly toolsOpen: boolean;
}

interface McpServerWithUsage extends McpServer {
    usedByAgents: string[];
}

export default function McpServerManager(_props: McpServerManagerProps) {
    const navigate = useNavigate();
    const apiClient = useMemo(() => generateClient(), []);

    const [mcpServers, setMcpServers] = useState<McpServerWithUsage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [showRegisterModal, setShowRegisterModal] = useState(false);

    const fetchMcpServersWithUsage = useCallback(async () => {
        setIsLoading(true);
        try {
            // Fetch MCP servers and agents in parallel
            const [mcpResult, agentsResult] = await Promise.all([
                apiClient.graphql({ query: listAvailableMcpServersQuery }),
                apiClient.graphql({ query: listRuntimeAgentsQuery }),
            ]);

            const servers = mcpResult.data?.listAvailableMcpServers || [];
            const agents = agentsResult.data?.listRuntimeAgents || [];

            // Build usage map: for each agent, fetch latest config and extract mcpServers
            const usageMap: Record<string, string[]> = {};
            servers.forEach((s) => {
                usageMap[s.name] = [];
            });

            // For each agent, get the latest version's config
            await Promise.all(
                agents
                    .filter((a) => a.status?.toLowerCase() === "ready")
                    .map(async (agent) => {
                        try {
                            const versionsResult = await apiClient.graphql({
                                query: listAgentVersionsQuery,
                                variables: { agentRuntimeId: agent.agentRuntimeId },
                            });
                            const versions = (versionsResult.data?.listAgentVersions || [])
                                .filter((v): v is string => v !== null)
                                .sort((a, b) => parseInt(b) - parseInt(a));

                            if (versions.length === 0) return;

                            const configResult = await apiClient.graphql({
                                query: getRuntimeConfigurationByVersionQuery,
                                variables: {
                                    agentName: agent.agentName,
                                    agentVersion: versions[0],
                                },
                            });

                            const config = JSON.parse(
                                configResult.data?.getRuntimeConfigurationByVersion || "{}",
                            );
                            const agentMcps: string[] = config.mcpServers || [];

                            agentMcps.forEach((mcpName) => {
                                if (usageMap[mcpName]) {
                                    usageMap[mcpName].push(agent.agentName);
                                }
                            });
                        } catch {
                            // Skip agents we can't read config for
                        }
                    }),
            );

            const serversWithUsage: McpServerWithUsage[] = servers.map((s) => ({
                ...s,
                usedByAgents: usageMap[s.name] || [],
            }));

            setMcpServers(serversWithUsage);
        } catch (error) {
            console.error("Failed to fetch MCP servers:", error);
        } finally {
            setIsLoading(false);
        }
    }, [apiClient]);

    useEffect(() => {
        fetchMcpServersWithUsage();
    }, [fetchMcpServersWithUsage]);

    const handleDelete = async (serverName: string) => {
        setIsDeleting(serverName);
        try {
            const result = await apiClient.graphql({
                query: deleteMcpServerMutation,
                variables: { name: serverName },
            });
            if (result.data?.deleteMcpServer?.status === ResponseStatus.SUCCESSFUL) {
                await fetchMcpServersWithUsage();
            }
        } catch (error) {
            console.error("Failed to delete MCP server:", error);
        } finally {
            setIsDeleting(null);
        }
    };

    return (
        <>
            <Container header="MCP Server Registry">
                <Table
                    items={mcpServers}
                    loading={isLoading}
                    loadingText="Loading MCP servers..."
                    stickyHeader
                    resizableColumns
                    header={
                        <Header
                            variant="awsui-h1-sticky"
                            description="Register, view, and manage MCP servers. Agents can connect to these servers for additional tools."
                            actions={
                                <SpaceBetween direction="horizontal" size="s">
                                    <Button
                                        iconName="add-plus"
                                        variant="inline-link"
                                        onClick={() => setShowRegisterModal(true)}
                                    >
                                        Register MCP Server
                                    </Button>
                                    <Button
                                        iconName="refresh"
                                        variant="inline-link"
                                        onClick={fetchMcpServersWithUsage}
                                    >
                                        Refresh
                                    </Button>
                                    <Button
                                        iconName="arrow-left"
                                        variant="inline-link"
                                        onClick={() => navigate("/agent-core")}
                                    >
                                        Go back
                                    </Button>
                                </SpaceBetween>
                            }
                        >
                            MCP Servers ({mcpServers.length})
                        </Header>
                    }
                    empty={
                        <Box textAlign="center" color="inherit" padding="l">
                            <Box variant="strong">No MCP servers registered</Box>
                            <Box variant="p" padding={{ bottom: "s" }}>
                                Register an MCP server to make it available for agents.
                            </Box>
                            <Button onClick={() => setShowRegisterModal(true)}>
                                Register MCP Server
                            </Button>
                        </Box>
                    }
                    columnDefinitions={[
                        {
                            id: "name",
                            header: "Name",
                            cell: (item) => (
                                <Popover
                                    header="Endpoint URL"
                                    content={
                                        <Box
                                            fontSize="body-s"
                                            color="text-body-secondary"
                                            variant="code"
                                        >
                                            {item.mcpUrl}
                                        </Box>
                                    }
                                    dismissButton={false}
                                    position="right"
                                    size="large"
                                >
                                    <strong style={{ cursor: "pointer" }}>{item.name}</strong>
                                </Popover>
                            ),
                            isRowHeader: true,
                            width: 220,
                        },
                        {
                            id: "authType",
                            header: "Auth",
                            cell: (item) => (
                                <StatusIndicator
                                    type={item.authType === "SIGV4" ? "success" : "info"}
                                >
                                    {item.authType === "SIGV4" ? "IAM (SigV4)" : "None"}
                                </StatusIndicator>
                            ),
                            width: 120,
                        },
                        {
                            id: "source",
                            header: "Source",
                            cell: (item) =>
                                item.source === "UI" ? "Registered (UI)" : "Config (Admin)",
                            width: 170,
                        },
                        {
                            id: "description",
                            header: "Description",
                            cell: (item) => (
                                <span style={{ whiteSpace: "pre-wrap" }}>
                                    {item.description || "—"}
                                </span>
                            ),
                            width: 280,
                        },
                        {
                            id: "usedBy",
                            header: "Used By Agents",
                            cell: (item) =>
                                item.usedByAgents.length > 0 ? item.usedByAgents.join(", ") : "—",
                            width: 200,
                        },
                        {
                            id: "actions",
                            header: "Actions",
                            cell: (item) =>
                                item.source === "UI" ? (
                                    <Button
                                        variant="inline-link"
                                        iconName="remove"
                                        loading={isDeleting === item.name}
                                        disabled={item.usedByAgents.length > 0}
                                        onClick={() => handleDelete(item.name)}
                                    >
                                        Delete
                                    </Button>
                                ) : (
                                    <Box color="text-status-inactive" fontSize="body-s">
                                        Managed by Admin
                                    </Box>
                                ),
                            width: 140,
                        },
                    ]}
                />
            </Container>

            <RegisterMcpServerModal
                visible={showRegisterModal}
                onDismiss={() => setShowRegisterModal(false)}
                onSuccess={() => {
                    setShowRegisterModal(false);
                    fetchMcpServersWithUsage();
                }}
            />
        </>
    );
}
