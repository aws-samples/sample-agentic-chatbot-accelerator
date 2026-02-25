// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Box,
    Button,
    ColumnLayout,
    FormField,
    Modal,
    Select,
    SpaceBetween,
    Table,
    Textarea,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useState } from "react";
import { McpServer } from "../../../API";
import { AppContext } from "../../../common/app-context";
import { listAvailableMcpServers as listAvailableMcpServersQuery } from "../../../graphql/queries";
import { AgentCoreRuntimeConfiguration, SwarmConfiguration } from "../../wizard/types";

const apiClient = generateClient();

const isSwarmConfig = (config: any): config is SwarmConfiguration => {
    return (
        config &&
        (Array.isArray(config.agents) || Array.isArray(config.agentReferences)) &&
        typeof config.entryAgent === "string"
    );
};

interface VersionInfo {
    version: string;
    qualifiers: string[];
}

interface ViewVersionModalProps {
    visible: boolean;
    onDismiss: () => void;
    agentName: string;
    versions: VersionInfo[];
    onVersionSelect: (version: string) => Promise<AgentCoreRuntimeConfiguration>;
}

export default function ViewVersionModal({
    visible,
    onDismiss,
    agentName,
    versions,
    onVersionSelect,
}: ViewVersionModalProps) {
    const appContext = useContext(AppContext);

    const [selectedVersion, setSelectedVersion] = useState<string>("");
    const [agentConfig, setAgentConfig] = useState<AgentCoreRuntimeConfiguration | null>(null);
    const [loadingConfig, setLoadingConfig] = useState(false);
    const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);

    const handleVersionChange = async (version: string) => {
        if (!version) return;

        setSelectedVersion(version);
        setLoadingConfig(true);

        try {
            const config = await onVersionSelect(version);
            setAgentConfig(config);
        } catch (error) {
            console.error("Failed to load agent config:", error);
            setAgentConfig(null);
        } finally {
            setLoadingConfig(false);
        }
    };

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

    // Fetch available MCP servers when modal opens
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

        if (visible) {
            fetchMcpServers();
        }
    }, [visible]);

    useEffect(() => {
        if (visible && versions.length > 0 && !selectedVersion) {
            // First try to find a version with DEFAULT qualifier
            const defaultVersion = versions.find((v) => v.qualifiers.includes("DEFAULT"));

            const versionToSelect = defaultVersion ? defaultVersion.version : versions[0].version;
            handleVersionChange(versionToSelect);
        }
    }, [visible, versions]);

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

    const isSwarm = agentConfig && isSwarmConfig(agentConfig);

    const toolTableItems =
        !isSwarm && agentConfig?.tools
            ? agentConfig.tools.map((toolName) => ({
                  name: toolName,
                  parameters: agentConfig.toolParameters[toolName] || {},
              }))
            : [];

    // Get MCP server details for configured servers
    const mcpServerTableItems =
        !isSwarm && agentConfig?.mcpServers
            ? agentConfig.mcpServers.map((serverName) => {
                  const serverInfo = availableMcpServers.find((s) => s.name === serverName);
                  return {
                      name: serverName,
                      description: serverInfo?.description || "No description available",
                  };
              })
            : [];

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            header={`View Agent: ${agentName}`}
            size="max"
            footer={
                <Box float="right">
                    <Button onClick={onDismiss}>Close</Button>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                <FormField label="Version" constraintText="Select version to view details">
                    <Select
                        selectedOption={
                            selectedVersion
                                ? (() => {
                                      const foundVersion = versions.find(
                                          (v) => v.version === selectedVersion,
                                      );
                                      const hasQualifiers =
                                          foundVersion?.qualifiers &&
                                          foundVersion.qualifiers.length > 0;
                                      return {
                                          label: hasQualifiers
                                              ? `${selectedVersion} (${foundVersion.qualifiers.join(", ")})`
                                              : selectedVersion,
                                          value: selectedVersion,
                                      };
                                  })()
                                : null
                        }
                        onChange={({ detail }) =>
                            handleVersionChange(detail.selectedOption?.value || "")
                        }
                        options={versions.map((v) => ({
                            label:
                                v.qualifiers.length > 0
                                    ? `${v.version} (${v.qualifiers.join(", ")})`
                                    : v.version,
                            value: v.version,
                        }))}
                        placeholder="Select version"
                    />
                </FormField>

                {loadingConfig ? (
                    <Box textAlign="center">Loading configuration...</Box>
                ) : agentConfig ? (
                    isSwarmConfig(agentConfig) ? (
                        <SpaceBetween direction="vertical" size="m">
                            <FormField label="Entry Agent">
                                <Box padding="m">{agentConfig.entryAgent}</Box>
                            </FormField>

                            {agentConfig.agents && agentConfig.agents.length > 0 && (
                                <FormField label="Inline Agents">
                                    <Table
                                        items={agentConfig.agents}
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Name",
                                                cell: (item: any) => item.name,
                                                isRowHeader: true,
                                            },
                                            {
                                                id: "model",
                                                header: "Model",
                                                cell: (item: any) =>
                                                    getModelName(
                                                        item.modelInferenceParameters?.modelId ||
                                                            "",
                                                    ),
                                            },
                                            {
                                                id: "tools",
                                                header: "Tools",
                                                cell: (item: any) =>
                                                    item.tools?.length > 0
                                                        ? item.tools.join(", ")
                                                        : "None",
                                            },
                                        ]}
                                    />
                                </FormField>
                            )}

                            {agentConfig.agentReferences &&
                                agentConfig.agentReferences.length > 0 && (
                                    <FormField label="Agent References">
                                        <Table
                                            items={agentConfig.agentReferences}
                                            columnDefinitions={[
                                                {
                                                    id: "agentName",
                                                    header: "Agent Name",
                                                    cell: (item: any) => item.agentName,
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

                            {agentConfig.orchestrator && (
                                <FormField label="Orchestrator Settings">
                                    <Box padding="m">
                                        <ColumnLayout columns={4} variant="text-grid">
                                            <div>
                                                <Box variant="awsui-key-label">Max Handoffs</Box>
                                                <Box>
                                                    {agentConfig.orchestrator.maxHandoffs ?? "N/A"}
                                                </Box>
                                            </div>
                                            <div>
                                                <Box variant="awsui-key-label">Max Iterations</Box>
                                                <Box>
                                                    {agentConfig.orchestrator.maxIterations ??
                                                        "N/A"}
                                                </Box>
                                            </div>
                                            <div>
                                                <Box variant="awsui-key-label">
                                                    Execution Timeout
                                                </Box>
                                                <Box>
                                                    {agentConfig.orchestrator
                                                        .executionTimeoutSeconds ?? "N/A"}
                                                    s
                                                </Box>
                                            </div>
                                            <div>
                                                <Box variant="awsui-key-label">Node Timeout</Box>
                                                <Box>
                                                    {agentConfig.orchestrator.nodeTimeoutSeconds ??
                                                        "N/A"}
                                                    s
                                                </Box>
                                            </div>
                                        </ColumnLayout>
                                    </Box>
                                </FormField>
                            )}

                            {agentConfig.conversationManager && (
                                <FormField label="Conversation Manager">
                                    <Box padding="m">{agentConfig.conversationManager}</Box>
                                </FormField>
                            )}
                        </SpaceBetween>
                    ) : (
                    <SpaceBetween direction="vertical" size="m">
                        <FormField label="Model Configuration">
                            <Box padding="m">
                                <ColumnLayout columns={3} variant="text-grid">
                                    <div>
                                        <Box variant="awsui-key-label">Model</Box>
                                        <Box>
                                            {getModelName(
                                                agentConfig.modelInferenceParameters.modelId,
                                            )}
                                        </Box>
                                    </div>
                                    <div>
                                        <Box variant="awsui-key-label">Temperature</Box>
                                        <Box>
                                            {agentConfig.modelInferenceParameters.parameters
                                                .temperature ?? "N/A"}
                                        </Box>
                                    </div>
                                    <div>
                                        <Box variant="awsui-key-label">Max Tokens</Box>
                                        <Box>
                                            {agentConfig.modelInferenceParameters.parameters
                                                .maxTokens ?? "N/A"}
                                        </Box>
                                    </div>
                                </ColumnLayout>
                            </Box>
                        </FormField>

                        <FormField label="Agent Instructions">
                            <Textarea value={agentConfig.instructions} disabled rows={6} />
                        </FormField>

                        {toolTableItems.length > 0 && (
                            <FormField label="Tools and Parameters">
                                <Table
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
                                                    return (
                                                        <Box color="text-status-inactive">None</Box>
                                                    );
                                                }
                                                return renderValue(item.parameters);
                                            },
                                        },
                                    ]}
                                />
                            </FormField>
                        )}

                        {mcpServerTableItems.length > 0 && (
                            <FormField label="MCP Servers">
                                <Table
                                    items={mcpServerTableItems}
                                    columnDefinitions={[
                                        {
                                            id: "name",
                                            header: "Server Name",
                                            cell: (item) => item.name,
                                            isRowHeader: true,
                                        },
                                        {
                                            id: "description",
                                            header: "Description",
                                            cell: (item) => (
                                                <Box
                                                    color={
                                                        item.description ===
                                                        "No description available"
                                                            ? "text-status-inactive"
                                                            : undefined
                                                    }
                                                >
                                                    {item.description}
                                                </Box>
                                            ),
                                        },
                                    ]}
                                />
                            </FormField>
                        )}
                    </SpaceBetween>
                    )
                ) : null}
            </SpaceBetween>
        </Modal>
    );
}
