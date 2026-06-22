// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Box,
    ColumnLayout,
    ExpandableSection,
    FormField,
    SpaceBetween,
    StatusIndicator,
    Table,
} from "@cloudscape-design/components";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useState } from "react";
import { McpServer, RuntimeSummary } from "../../../API";
import { AppContext } from "../../../common/app-context";
import { listAvailableMcpServers as listAvailableMcpServersQuery } from "../../../graphql/queries";
import GraphMinimap from "../../wizard/architectures/graph-minimap";
import {
    AgentCoreRuntimeConfiguration,
    AgentsAsToolsConfiguration,
    GraphConfiguration,
    SwarmConfiguration,
} from "../../wizard/types";

const apiClient = generateClient();

const isSwarmConfig = (config: any): config is SwarmConfiguration => {
    return (
        config &&
        (Array.isArray(config.agents) || Array.isArray(config.agentReferences)) &&
        typeof config.entryAgent === "string"
    );
};

const isGraphConfig = (config: any): config is GraphConfiguration => {
    return config && Array.isArray(config.nodes) && typeof config.entryPoint === "string";
};

const isAgentsAsToolsConfig = (config: any): config is AgentsAsToolsConfiguration => {
    return (
        config &&
        Array.isArray(config.agentsAsTools) &&
        config.modelInferenceParameters &&
        typeof config.instructions === "string"
    );
};

/**
 * A sub-agent referenced by another agent's configuration. Swarm/graph references carry
 * an `agentName`; agents-as-tools references carry a `runtimeId` (HTTP id or A2A twin ARN).
 */
export interface AgentReferenceTarget {
    agentName?: string;
    runtimeId?: string;
    endpoint?: string;
    /** The text the consumer would display when not rendering a drill-down link. */
    display: string;
}

export interface AgentConfigViewProps {
    config: AgentCoreRuntimeConfiguration;
    /**
     * Optional drill-down renderer for a referenced sub-agent. The View modal supplies
     * this to turn references into clickable links; the wizard Review step omits it, so
     * references render as the plain `display` text.
     */
    renderAgentReference?: (target: AgentReferenceTarget) => React.ReactNode;
    /**
     * Known runtimes, used to resolve an agents-as-tools `runtimeId` (HTTP id or A2A twin
     * ARN) to a human-readable agent name when no `renderAgentReference` is supplied.
     * Without it, an unresolved reference falls back to showing the raw id/ARN.
     */
    agents?: RuntimeSummary[];
}

/**
 * Read-only, per-architecture detail renderer for an AgentCore runtime configuration.
 * Shared by the AgentCore "View" modal and the agent-creation wizard Review step so both
 * surfaces present the same structured view. Branches Swarm → Agents-as-Tools → Graph →
 * Single agent on the flattened config shape.
 */
export default function AgentConfigView({
    config,
    renderAgentReference,
    agents,
}: AgentConfigViewProps) {
    const appContext = useContext(AppContext);
    const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);

    // Resolve a runtimeId (HTTP id or A2A twin ARN) to its agent name, falling back to
    // the raw id when no match is found. Used for the plain-text (non-drill-down) path.
    const resolveRuntimeName = (runtimeId: string): string => {
        const match = agents?.find(
            (a) => a.agentRuntimeId === runtimeId || a.agentRuntimeArnA2A === runtimeId,
        );
        return match?.agentName ?? runtimeId;
    };

    useEffect(() => {
        const fetchMcpServers = async () => {
            try {
                const result = await apiClient.graphql({ query: listAvailableMcpServersQuery });
                if (result.data?.listAvailableMcpServers) {
                    setAvailableMcpServers(result.data.listAvailableMcpServers as McpServer[]);
                }
            } catch (error) {
                console.error("Failed to fetch MCP servers:", error);
            }
        };
        fetchMcpServers();
    }, []);

    // Render an agent reference as a drill-down link when wired, else as plain text.
    const refOrText = (target: AgentReferenceTarget): React.ReactNode =>
        renderAgentReference ? renderAgentReference(target) : target.display;

    const getModelName = (modelId: string) => {
        if (!appContext?.aws_bedrock_supported_models) return modelId;

        const regionPrefix = appContext.aws_project_region.split("-")[0];

        for (const [label, templateValue] of Object.entries(
            appContext.aws_bedrock_supported_models,
        )) {
            const processedValue = templateValue.replace("[REGION-PREFIX]", regionPrefix);
            if (processedValue === modelId) {
                return label;
            }
        }

        return modelId; // fallback to showing the ID if no match found
    };

    const isThinkingEnabled = (reasoningBudget: number | string | null | undefined): boolean => {
        return (
            reasoningBudget !== undefined &&
            reasoningBudget !== null &&
            reasoningBudget !== "disabled" &&
            reasoningBudget !== 0
        );
    };

    const renderThinkingStatus = (reasoningBudget: number | string | null | undefined) => {
        if (isThinkingEnabled(reasoningBudget)) {
            const budgetLabel =
                typeof reasoningBudget === "number"
                    ? `${reasoningBudget} tokens`
                    : String(reasoningBudget);
            return (
                <SpaceBetween direction="vertical" size="xxs">
                    <StatusIndicator type="success">Enabled</StatusIndicator>
                    <Box variant="awsui-key-label" display="inline">
                        Budget:{" "}
                        <Box display="inline" fontWeight="normal">
                            {budgetLabel}
                        </Box>
                    </Box>
                </SpaceBetween>
            );
        }
        return <StatusIndicator type="stopped">Disabled</StatusIndicator>;
    };

    const renderMemoryStatus = (useMemory: boolean | undefined) => {
        if (useMemory) {
            return <StatusIndicator type="success">Attached</StatusIndicator>;
        }
        return <StatusIndicator type="stopped">Not attached</StatusIndicator>;
    };

    // Recursive function to render parameter values
    const renderValue = (value: unknown, depth: number = 0): React.ReactNode => {
        if (value === null || value === undefined) {
            return <Box color="text-status-inactive">null</Box>;
        }

        if (Array.isArray(value)) {
            if (value.length === 0) {
                return <Box color="text-status-inactive">[]</Box>;
            }
            return (
                <SpaceBetween direction="vertical" size="xxs">
                    {value.map((item, index) => (
                        <Box key={index} margin={{ left: depth > 0 ? "l" : undefined }}>
                            <Box variant="awsui-key-label" display="inline">
                                [{index}]:
                            </Box>{" "}
                            {renderValue(item, depth + 1)}
                        </Box>
                    ))}
                </SpaceBetween>
            );
        }

        if (typeof value === "object") {
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) {
                return <Box color="text-status-inactive">{"{}"}</Box>;
            }
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    {entries.map(([key, val]) => (
                        <div key={key} style={{ marginLeft: depth > 0 ? "16px" : undefined }}>
                            {typeof val === "object" && val !== null ? (
                                <>
                                    <Box variant="awsui-key-label">{key}:</Box>
                                    <div style={{ marginTop: "2px" }}>
                                        {renderValue(val, depth + 1)}
                                    </div>
                                </>
                            ) : (
                                <span>
                                    <Box variant="awsui-key-label" display="inline">
                                        {key}:
                                    </Box>{" "}
                                    {renderValue(val, depth + 1)}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            );
        }

        if (typeof value === "boolean") {
            return (
                <Box display="inline" color="text-status-info">
                    {value.toString()}
                </Box>
            );
        }

        if (typeof value === "number") {
            return <Box display="inline">{value}</Box>;
        }

        return <Box display="inline">{String(value)}</Box>;
    };

    // Map a list of MCP server names to display rows with descriptions.
    const buildMcpItems = (servers: string[]) =>
        servers.map((serverName) => {
            const serverInfo = availableMcpServers.find((s) => s.name === serverName);
            return {
                name: serverName,
                description: serverInfo?.description || "No description available",
            };
        });

    type McpServerRow = { name: string; description: string };
    const mcpServerColumns = [
        {
            id: "name",
            header: "Server Name",
            cell: (item: McpServerRow) => item.name,
            isRowHeader: true,
        },
        {
            id: "description",
            header: "Description",
            cell: (item: McpServerRow) => (
                <Box
                    color={
                        item.description === "No description available"
                            ? "text-status-inactive"
                            : undefined
                    }
                >
                    {item.description}
                </Box>
            ),
        },
    ];

    // ── Swarm ──────────────────────────────────────────────────────────
    if (isSwarmConfig(config)) {
        return (
            <SpaceBetween direction="vertical" size="m">
                <FormField label="Entry Agent">
                    <Box padding="m">{config.entryAgent}</Box>
                </FormField>

                <FormField label="AgentCore Memory">
                    <Box padding="m">{renderMemoryStatus(config.useMemory)}</Box>
                </FormField>

                {config.agents && config.agents.length > 0 && (
                    <FormField label="Inline Agents">
                        <SpaceBetween direction="vertical" size="xs">
                            {config.agents.map((inlineAgent, idx) => {
                                const params = inlineAgent.modelInferenceParameters?.parameters;
                                const inlineMcp = buildMcpItems(inlineAgent.mcpServers || []);
                                const inlineToolParams = inlineAgent.toolParameters || {};
                                return (
                                    <ExpandableSection
                                        key={idx}
                                        variant="container"
                                        headerText={inlineAgent.name}
                                    >
                                        <SpaceBetween direction="vertical" size="m">
                                            <ColumnLayout columns={4} variant="text-grid">
                                                <div>
                                                    <Box variant="awsui-key-label">Model</Box>
                                                    <Box>
                                                        {getModelName(
                                                            inlineAgent.modelInferenceParameters
                                                                ?.modelId || "",
                                                        )}
                                                    </Box>
                                                </div>
                                                <div>
                                                    <Box variant="awsui-key-label">
                                                        Temperature
                                                    </Box>
                                                    <Box>{params?.temperature ?? "N/A"}</Box>
                                                </div>
                                                <div>
                                                    <Box variant="awsui-key-label">Max Tokens</Box>
                                                    <Box>{params?.maxTokens ?? "N/A"}</Box>
                                                </div>
                                                <div>
                                                    <Box variant="awsui-key-label">Thinking</Box>
                                                    <Box>
                                                        {renderThinkingStatus(
                                                            inlineAgent.modelInferenceParameters
                                                                ?.reasoningBudget,
                                                        )}
                                                    </Box>
                                                </div>
                                            </ColumnLayout>

                                            <div>
                                                <Box variant="awsui-key-label">Tools</Box>
                                                <Box>
                                                    {inlineAgent.tools?.length > 0
                                                        ? inlineAgent.tools.join(", ")
                                                        : "None"}
                                                </Box>
                                            </div>

                                            {inlineMcp.length > 0 && (
                                                <div>
                                                    <Box variant="awsui-key-label">MCP Servers</Box>
                                                    <Table
                                                        variant="embedded"
                                                        items={inlineMcp}
                                                        columnDefinitions={mcpServerColumns}
                                                    />
                                                </div>
                                            )}

                                            {Object.keys(inlineToolParams).length > 0 && (
                                                <div>
                                                    <Box variant="awsui-key-label">
                                                        Tool Parameters
                                                    </Box>
                                                    {renderValue(inlineToolParams)}
                                                </div>
                                            )}

                                            <FormField
                                                label={
                                                    <SpaceBetween
                                                        direction="horizontal"
                                                        size="xs"
                                                        alignItems="center"
                                                    >
                                                        <span>Instructions</span>
                                                        <CopyToClipboard
                                                            textToCopy={
                                                                inlineAgent.instructions || ""
                                                            }
                                                            variant="icon"
                                                            copySuccessText="Instructions copied"
                                                            copyErrorText="Failed to copy"
                                                        />
                                                    </SpaceBetween>
                                                }
                                            >
                                                <ExpandableSection
                                                    headerText="Show instructions"
                                                    defaultExpanded={false}
                                                >
                                                    <Box padding="m" variant="code">
                                                        <pre
                                                            style={{
                                                                margin: 0,
                                                                whiteSpace: "pre-wrap",
                                                                wordWrap: "break-word",
                                                            }}
                                                        >
                                                            {inlineAgent.instructions}
                                                        </pre>
                                                    </Box>
                                                </ExpandableSection>
                                            </FormField>
                                        </SpaceBetween>
                                    </ExpandableSection>
                                );
                            })}
                        </SpaceBetween>
                    </FormField>
                )}

                {config.agentReferences && config.agentReferences.length > 0 && (
                    <FormField label="Agent References">
                        <Table
                            variant="embedded"
                            items={config.agentReferences}
                            columnDefinitions={[
                                {
                                    id: "agentName",
                                    header: "Agent Name",
                                    cell: (item: any) =>
                                        refOrText({
                                            agentName: item.agentName,
                                            endpoint: item.endpointName,
                                            display: item.agentName,
                                        }),
                                    isRowHeader: true,
                                },
                                {
                                    id: "endpointName",
                                    header: "Endpoint",
                                    cell: (item: any) => item.endpointName,
                                },
                            ]}
                        />
                    </FormField>
                )}

                {config.orchestrator && (
                    <FormField label="Orchestrator Settings">
                        <Box padding="m">
                            <ColumnLayout columns={4} variant="text-grid">
                                <div>
                                    <Box variant="awsui-key-label">Max Handoffs</Box>
                                    <Box>{config.orchestrator.maxHandoffs ?? "N/A"}</Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Max Iterations</Box>
                                    <Box>{config.orchestrator.maxIterations ?? "N/A"}</Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Execution Timeout</Box>
                                    <Box>
                                        {config.orchestrator.executionTimeoutSeconds ?? "N/A"}s
                                    </Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Node Timeout</Box>
                                    <Box>{config.orchestrator.nodeTimeoutSeconds ?? "N/A"}s</Box>
                                </div>
                            </ColumnLayout>
                        </Box>
                    </FormField>
                )}

                {config.conversationManager && (
                    <FormField label="Conversation Manager">
                        <Box padding="m">{config.conversationManager}</Box>
                    </FormField>
                )}
            </SpaceBetween>
        );
    }

    // ── Agents-as-Tools (orchestrator) ─────────────────────────────────
    if (isAgentsAsToolsConfig(config)) {
        return (
            <SpaceBetween direction="vertical" size="m">
                <FormField label="Model Configuration">
                    <Box padding="m">
                        <ColumnLayout columns={4} variant="text-grid">
                            <div>
                                <Box variant="awsui-key-label">Model</Box>
                                <Box>
                                    {getModelName(config.modelInferenceParameters?.modelId || "")}
                                </Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Temperature</Box>
                                <Box>
                                    {config.modelInferenceParameters?.parameters?.temperature ??
                                        "N/A"}
                                </Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Max Tokens</Box>
                                <Box>
                                    {config.modelInferenceParameters?.parameters?.maxTokens ??
                                        "N/A"}
                                </Box>
                            </div>
                            <div>
                                <Box variant="awsui-key-label">Thinking</Box>
                                <Box>
                                    {renderThinkingStatus(
                                        config.modelInferenceParameters?.reasoningBudget,
                                    )}
                                </Box>
                            </div>
                        </ColumnLayout>
                    </Box>
                </FormField>

                <FormField label="AgentCore Memory">
                    <Box padding="m">{renderMemoryStatus((config as any).useMemory)}</Box>
                </FormField>

                <FormField
                    label={
                        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                            <span>Orchestrator Instructions</span>
                            <CopyToClipboard
                                textToCopy={config.instructions || ""}
                                variant="icon"
                                copySuccessText="Instructions copied"
                                copyErrorText="Failed to copy"
                            />
                        </SpaceBetween>
                    }
                >
                    <ExpandableSection headerText="Show instructions" defaultExpanded={false}>
                        <Box padding="m" variant="code">
                            <pre
                                style={{
                                    margin: 0,
                                    whiteSpace: "pre-wrap",
                                    wordWrap: "break-word",
                                }}
                            >
                                {config.instructions}
                            </pre>
                        </Box>
                    </ExpandableSection>
                </FormField>

                {config.agentsAsTools && config.agentsAsTools.length > 0 && (
                    <FormField label="Agents as Tools">
                        <Table
                            variant="embedded"
                            items={config.agentsAsTools}
                            columnDefinitions={[
                                {
                                    id: "agentName",
                                    header: "Agent",
                                    cell: (item: any) =>
                                        refOrText({
                                            runtimeId: item.runtimeId,
                                            endpoint: item.endpoint,
                                            display: resolveRuntimeName(item.runtimeId),
                                        }),
                                    isRowHeader: true,
                                },
                                {
                                    id: "endpoint",
                                    header: "Endpoint",
                                    cell: (item: any) => item.endpoint || "DEFAULT",
                                },
                            ]}
                        />
                    </FormField>
                )}

                {config.tools && config.tools.length > 0 && (
                    <FormField label="Additional Tools">
                        <Table
                            variant="embedded"
                            items={config.tools.map((toolName: string) => ({
                                name: toolName,
                                parameters: config.toolParameters?.[toolName] || {},
                            }))}
                            columnDefinitions={[
                                {
                                    id: "name",
                                    header: "Tool Name",
                                    cell: (item: any) => item.name,
                                    isRowHeader: true,
                                },
                                {
                                    id: "parameters",
                                    header: "Parameters",
                                    cell: (item: any) => {
                                        if (Object.keys(item.parameters).length === 0) {
                                            return <Box color="text-status-inactive">None</Box>;
                                        }
                                        return renderValue(item.parameters);
                                    },
                                },
                            ]}
                        />
                    </FormField>
                )}

                {config.mcpServers && config.mcpServers.length > 0 && (
                    <FormField label="MCP Servers">
                        <Table
                            variant="embedded"
                            items={buildMcpItems(config.mcpServers)}
                            columnDefinitions={mcpServerColumns}
                        />
                    </FormField>
                )}

                {config.conversationManager && (
                    <FormField label="Conversation Manager">
                        <Box padding="m">{config.conversationManager}</Box>
                    </FormField>
                )}
            </SpaceBetween>
        );
    }

    // ── Graph ──────────────────────────────────────────────────────────
    if (isGraphConfig(config)) {
        return (
            <SpaceBetween direction="vertical" size="m">
                <FormField label="Entry Point">
                    <Box padding="m">{config.entryPoint}</Box>
                </FormField>

                <FormField label="AgentCore Memory">
                    <Box padding="m">{renderMemoryStatus(config.useMemory)}</Box>
                </FormField>

                {config.nodes && config.nodes.length > 0 && (
                    <FormField label="Graph Nodes">
                        <Table
                            variant="embedded"
                            items={config.nodes}
                            columnDefinitions={[
                                {
                                    id: "id",
                                    header: "Node ID",
                                    cell: (item: any) => item.id,
                                    isRowHeader: true,
                                },
                                {
                                    id: "agentName",
                                    header: "Agent",
                                    cell: (item: any) =>
                                        item.agentName ? (
                                            refOrText({
                                                agentName: item.agentName,
                                                endpoint: item.endpointName,
                                                display: item.agentName,
                                            })
                                        ) : (
                                            <Box color="text-status-inactive">
                                                {item.deterministicNodeKey ||
                                                    item.nodeType ||
                                                    "-"}
                                            </Box>
                                        ),
                                },
                                {
                                    id: "endpointName",
                                    header: "Endpoint",
                                    cell: (item: any) => item.endpointName || "DEFAULT",
                                },
                                {
                                    id: "label",
                                    header: "Label",
                                    cell: (item: any) => item.label || "-",
                                },
                                {
                                    id: "dynamicMap",
                                    header: "Dynamic Map",
                                    cell: (item: any) =>
                                        item.dynamicMapConfig ? (
                                            <Box fontSize="body-s">
                                                {item.dynamicMapConfig.sourceKey} →{" "}
                                                {item.dynamicMapConfig.targetNode}
                                            </Box>
                                        ) : (
                                            <Box color="text-status-inactive">-</Box>
                                        ),
                                },
                                {
                                    id: "promptTemplate",
                                    header: "Prompt Template",
                                    cell: (item: any) =>
                                        item.promptTemplate ? (
                                            <span
                                                title={item.promptTemplate}
                                                style={{
                                                    display: "-webkit-box",
                                                    WebkitLineClamp: 2,
                                                    WebkitBoxOrient: "vertical" as const,
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "pre-wrap",
                                                    maxWidth: 250,
                                                    fontSize: 12,
                                                }}
                                            >
                                                {item.promptTemplate}
                                            </span>
                                        ) : (
                                            <Box color="text-status-inactive">-</Box>
                                        ),
                                },
                            ]}
                        />
                    </FormField>
                )}

                {config.edges && config.edges.length > 0 && (
                    <FormField label="Edges">
                        <Table
                            variant="embedded"
                            items={config.edges}
                            columnDefinitions={[
                                {
                                    id: "source",
                                    header: "Source",
                                    cell: (item: any) => item.source,
                                    isRowHeader: true,
                                },
                                {
                                    id: "target",
                                    header: "Target",
                                    cell: (item: any) => item.target,
                                },
                                {
                                    id: "condition",
                                    header: "Condition",
                                    cell: (item: any) =>
                                        item.condition || (
                                            <Box color="text-status-inactive">-</Box>
                                        ),
                                },
                            ]}
                        />
                    </FormField>
                )}

                <FormField label="Graph State">
                    <Box padding="m">
                        {config.stateClass ? (
                            <div>
                                <Box variant="awsui-key-label">State Class</Box>
                                <Box>{config.stateClass}</Box>
                            </div>
                        ) : config.stateSchema &&
                          Object.keys(config.stateSchema).length > 0 ? (
                            <SpaceBetween direction="vertical" size="xs">
                                {Object.entries(config.stateSchema).map(([key, type]) => (
                                    <Box key={key}>
                                        <Box variant="awsui-key-label" display="inline">
                                            {key}:
                                        </Box>{" "}
                                        <Box display="inline">{String(type)}</Box>
                                    </Box>
                                ))}
                            </SpaceBetween>
                        ) : (
                            <Box color="text-status-inactive">Not configured</Box>
                        )}
                    </Box>
                </FormField>

                <FormField label="Graph Topology">
                    <GraphMinimap
                        graphConfig={{
                            nodes: config.nodes || [],
                            edges: config.edges || [],
                            entryPoint: config.entryPoint,
                            stateSchema: config.stateSchema || {},
                            stateClass: config.stateClass,
                            orchestrator: config.orchestrator || {
                                maxIterations: 50,
                                executionTimeoutSeconds: 300,
                                nodeTimeoutSeconds: 60,
                            },
                        }}
                    />
                </FormField>

                {config.orchestrator && (
                    <FormField label="Orchestrator Settings">
                        <Box padding="m">
                            <ColumnLayout columns={3} variant="text-grid">
                                <div>
                                    <Box variant="awsui-key-label">Max Iterations</Box>
                                    <Box>{config.orchestrator.maxIterations ?? "N/A"}</Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Execution Timeout</Box>
                                    <Box>
                                        {config.orchestrator.executionTimeoutSeconds ?? "N/A"}s
                                    </Box>
                                </div>
                                <div>
                                    <Box variant="awsui-key-label">Node Timeout</Box>
                                    <Box>{config.orchestrator.nodeTimeoutSeconds ?? "N/A"}s</Box>
                                </div>
                            </ColumnLayout>
                        </Box>
                    </FormField>
                )}
            </SpaceBetween>
        );
    }

    // ── Single agent ───────────────────────────────────────────────────
    const toolTableItems = (config.tools || []).map((toolName) => ({
        name: toolName,
        parameters: config.toolParameters?.[toolName] || {},
    }));
    const mcpServerTableItems = config.mcpServers ? buildMcpItems(config.mcpServers) : [];
    return (
        <SpaceBetween direction="vertical" size="m">
            <FormField label="Model Configuration">
                <Box padding="m">
                    <ColumnLayout columns={4} variant="text-grid">
                        <div>
                            <Box variant="awsui-key-label">Model</Box>
                            <Box>{getModelName(config.modelInferenceParameters.modelId)}</Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Temperature</Box>
                            <Box>
                                {config.modelInferenceParameters.parameters.temperature ?? "N/A"}
                            </Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Max Tokens</Box>
                            <Box>
                                {config.modelInferenceParameters.parameters.maxTokens ?? "N/A"}
                            </Box>
                        </div>
                        <div>
                            <Box variant="awsui-key-label">Thinking</Box>
                            <Box>
                                {renderThinkingStatus(
                                    config.modelInferenceParameters.reasoningBudget,
                                )}
                            </Box>
                        </div>
                    </ColumnLayout>
                </Box>
            </FormField>

            <FormField label="AgentCore Memory">
                <Box padding="m">{renderMemoryStatus(config.useMemory)}</Box>
            </FormField>

            <FormField
                label="Agent Description"
                description="Capability blurb published in this agent's A2A agent card."
            >
                <Box padding="m">
                    {config.description || <Box color="text-status-inactive">Not set</Box>}
                </Box>
            </FormField>

            <FormField
                label={
                    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                        <span>Agent Instructions</span>
                        <CopyToClipboard
                            textToCopy={config.instructions}
                            variant="icon"
                            copySuccessText="Instructions copied"
                            copyErrorText="Failed to copy"
                        />
                    </SpaceBetween>
                }
            >
                <ExpandableSection headerText="Show instructions" defaultExpanded={false}>
                    <Box padding="m" variant="code">
                        <pre
                            style={{
                                margin: 0,
                                whiteSpace: "pre-wrap",
                                wordWrap: "break-word",
                            }}
                        >
                            {config.instructions}
                        </pre>
                    </Box>
                </ExpandableSection>
            </FormField>

            {toolTableItems.length > 0 && (
                <FormField label="Tools and Parameters">
                    <Table
                        variant="embedded"
                        items={toolTableItems}
                        columnDefinitions={[
                            {
                                id: "name",
                                header: "Tool Name",
                                cell: (item) => item.name,
                                isRowHeader: true,
                            },
                            {
                                id: "parameters",
                                header: "Parameters",
                                cell: (item) => {
                                    if (Object.keys(item.parameters).length === 0) {
                                        return <Box color="text-status-inactive">None</Box>;
                                    }
                                    return renderValue(item.parameters);
                                },
                            },
                        ]}
                    />
                </FormField>
            )}

            {config.skills && config.skills.length > 0 && (
                <FormField label="Skills">
                    <Box padding="m">{config.skills.join(", ")}</Box>
                </FormField>
            )}

            {mcpServerTableItems.length > 0 && (
                <FormField label="MCP Servers">
                    <Table
                        variant="embedded"
                        items={mcpServerTableItems}
                        columnDefinitions={mcpServerColumns}
                    />
                </FormField>
            )}

            <FormField label="Structured Output">
                {Array.isArray(config.structuredOutput) && config.structuredOutput.length > 0 ? (
                    <Table
                        variant="embedded"
                        items={config.structuredOutput}
                        columnDefinitions={[
                            {
                                id: "name",
                                header: "Field Name",
                                cell: (item) => item.name,
                                isRowHeader: true,
                            },
                            {
                                id: "pythonType",
                                header: "Python Type",
                                cell: (item) => (
                                    <span style={{ fontFamily: "monospace" }}>
                                        {item.pythonType}
                                    </span>
                                ),
                            },
                            {
                                id: "description",
                                header: "Description",
                                cell: (item) => (
                                    <span style={{ whiteSpace: "pre-wrap" }}>
                                        {item.description}
                                    </span>
                                ),
                            },
                            {
                                id: "optional",
                                header: "Optional",
                                cell: (item) =>
                                    item.optional ? (
                                        <StatusIndicator type="info">Yes</StatusIndicator>
                                    ) : (
                                        <StatusIndicator type="stopped">No</StatusIndicator>
                                    ),
                            },
                        ]}
                    />
                ) : (
                    <Box padding="m">
                        <StatusIndicator type="stopped">Not configured</StatusIndicator>
                    </Box>
                )}
            </FormField>

            {config.conversationManager && (
                <FormField label="Conversation Manager">
                    <Box padding="m">{config.conversationManager}</Box>
                </FormField>
            )}
        </SpaceBetween>
    );
}
