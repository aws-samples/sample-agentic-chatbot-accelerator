// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    BreadcrumbGroup,
    Button,
    ColumnLayout,
    ExpandableSection,
    FormField,
    Link,
    Modal,
    Select,
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

interface VersionInfo {
    version: string;
    qualifiers: string[];
}

// One step in the drill-down navigation. stack[0] is the agent the user opened
// from the table; the top of the stack is the agent currently displayed.
interface NavFrame {
    agentName: string;
    agentRuntimeId?: string; // needed to fetch versions; absent if unresolved
    versions: VersionInfo[];
    selectedVersion: string;
    // Set when this frame was reached by drilling into a reference: the view is
    // pinned to this referenced endpoint (read-only) instead of offering a free
    // version selector. Absent for the root frame opened from the table.
    pinnedEndpoint?: string;
    config: AgentCoreRuntimeConfiguration | null;
    error: string | null;
}

interface ViewVersionModalProps {
    visible: boolean;
    onDismiss: () => void;
    agentName: string;
    agentRuntimeId: string;
    versions: VersionInfo[];
    agents: RuntimeSummary[];
    onVersionSelect: (agentName: string, version: string) => Promise<AgentCoreRuntimeConfiguration>;
}

export default function ViewVersionModal({
    visible,
    onDismiss,
    agentName,
    agentRuntimeId,
    versions,
    agents,
    onVersionSelect,
}: ViewVersionModalProps) {
    const appContext = useContext(AppContext);

    const [stack, setStack] = useState<NavFrame[]>([]);
    const [loadingConfig, setLoadingConfig] = useState(false);
    const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);

    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    const agentConfig = current?.config ?? null;
    const selectedVersion = current?.selectedVersion ?? "";

    // Merge a patch into the currently displayed (top) frame.
    const updateTopFrame = (patch: Partial<NavFrame>) => {
        setStack((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], ...patch };
            return next;
        });
    };

    // Load a config for a given agent + version, normalizing fetch failures into
    // a frame-level error string (instead of a blank modal body).
    const loadConfig = async (name: string, version: string) => {
        try {
            const config = await onVersionSelect(name, version);
            return { config, error: null as string | null };
        } catch (error) {
            console.error("Failed to load agent config:", error);
            return { config: null, error: "Failed to load configuration for this version." };
        }
    };

    const handleVersionChange = async (version: string) => {
        if (!version || !current) return;

        const name = current.agentName;
        updateTopFrame({ selectedVersion: version, error: null });
        setLoadingConfig(true);
        const { config, error } = await loadConfig(name, version);
        updateTopFrame({ config, error });
        setLoadingConfig(false);
    };

    // ---- Reference resolution (Part B2) --------------------------------
    // Swarm / Graph references carry an agentName directly; Agents-as-Tools
    // carries a runtimeId that is either the HTTP id (just-added) or the A2A
    // twin ARN (persisted) — match both shapes.
    const findRuntimeByName = (name: string): RuntimeSummary | null =>
        agents.find((a) => a.agentName === name) ?? null;

    const findRuntimeById = (id: string): RuntimeSummary | null =>
        agents.find((a) => a.agentRuntimeId === id || a.agentRuntimeArnA2A === id) ?? null;

    const getAgentNameByRuntimeId = (id: string): string => findRuntimeById(id)?.agentName ?? id;

    // Push a sub-agent onto the stack and load its config. A reference targets a
    // specific endpoint, so the pushed frame is pinned to it (Part B3): we resolve
    // endpoint → version and lock the view rather than offering a version selector.
    const drillInto = async (runtime: RuntimeSummary, endpointName?: string) => {
        setLoadingConfig(true);
        try {
            const qtv = JSON.parse(runtime.qualifierToVersion || "{}");
            // The endpoint named on the reference, defaulting to DEFAULT.
            const pinnedEndpoint = endpointName || "DEFAULT";
            const version = qtv[pinnedEndpoint] ?? qtv["DEFAULT"] ?? Object.values(qtv)[0] ?? "";
            const { config, error } = await loadConfig(runtime.agentName, String(version));
            setStack((prev) => [
                ...prev,
                {
                    agentName: runtime.agentName,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versions: [],
                    selectedVersion: String(version),
                    pinnedEndpoint,
                    config,
                    error,
                },
            ]);
        } catch (error) {
            console.error("Failed to drill into sub-agent:", error);
            // Keep the parent intact; surface the failure in the pushed frame.
            setStack((prev) => [
                ...prev,
                {
                    agentName: runtime.agentName,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versions: [],
                    selectedVersion: "",
                    pinnedEndpoint: endpointName || "DEFAULT",
                    config: null,
                    error: "Failed to load this sub-agent.",
                },
            ]);
        } finally {
            setLoadingConfig(false);
        }
    };

    const goBack = () => setStack((prev) => prev.slice(0, -1));
    const popTo = (index: number) => setStack((prev) => prev.slice(0, index + 1));

    // A reference is drillable only if it resolves to a runtime in this account.
    // Otherwise (deleted, cross-account, raw runtimeId) render a non-clickable hint.
    const renderAgentRef = (
        displayName: string,
        runtime: RuntimeSummary | null,
        endpointName?: string,
    ): React.ReactNode => {
        if (runtime) {
            return <Link onFollow={() => drillInto(runtime, endpointName)}>{displayName}</Link>;
        }
        return (
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box display="inline">{displayName}</Box>
                <Box color="text-status-inactive" fontSize="body-s" display="inline">
                    (sub-agent no longer available)
                </Box>
            </SpaceBetween>
        );
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

    // Initialize the navigation stack with the opened (root) agent.
    useEffect(() => {
        if (visible && versions.length > 0 && stack.length === 0) {
            const defaultVersion = versions.find((v) => v.qualifiers.includes("DEFAULT"));
            const versionToSelect = defaultVersion ? defaultVersion.version : versions[0].version;

            const initRoot = async () => {
                setStack([
                    {
                        agentName,
                        agentRuntimeId,
                        versions,
                        selectedVersion: versionToSelect,
                        config: null,
                        error: null,
                    },
                ]);
                setLoadingConfig(true);
                const { config, error } = await loadConfig(agentName, versionToSelect);
                updateTopFrame({ config, error });
                setLoadingConfig(false);
            };

            initRoot();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, versions]);

    const handleDismiss = () => {
        setStack([]);
        onDismiss();
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

    const isSwarm = agentConfig && isSwarmConfig(agentConfig);
    const isAgentsAsTools =
        agentConfig &&
        !isSwarm &&
        !isGraphConfig(agentConfig) &&
        isAgentsAsToolsConfig(agentConfig);

    const toolTableItems =
        !isSwarm && agentConfig?.tools
            ? agentConfig.tools.map((toolName) => ({
                  name: toolName,
                  parameters: agentConfig.toolParameters[toolName] || {},
              }))
            : [];

    // Get MCP server details for configured servers (single-agent branch)
    const mcpServerTableItems =
        !isSwarm && agentConfig?.mcpServers ? buildMcpItems(agentConfig.mcpServers) : [];

    return (
        <Modal
            visible={visible}
            onDismiss={handleDismiss}
            header={`View Agent: ${current?.agentName ?? agentName}`}
            size="max"
            footer={
                <Box float="right">
                    <Button onClick={handleDismiss}>Close</Button>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                {/* Drill-down trail: breadcrumb + Back, shown only once nested */}
                {stack.length > 1 && (
                    <SpaceBetween direction="vertical" size="xs">
                        <BreadcrumbGroup
                            ariaLabel="Sub-agent navigation"
                            items={stack.map((f, i) => ({
                                text: f.agentName,
                                href: String(i),
                            }))}
                            onFollow={(event) => {
                                event.preventDefault();
                                const index = parseInt(event.detail.href, 10);
                                if (!Number.isNaN(index)) popTo(index);
                            }}
                        />
                        <Box>
                            <Button iconName="angle-left" onClick={goBack}>
                                Back to {stack[stack.length - 2].agentName}
                            </Button>
                        </Box>
                    </SpaceBetween>
                )}

                {current?.pinnedEndpoint ? (
                    // Drilled-in via a reference: the reference targets a specific
                    // endpoint, so the view is locked to it (read-only).
                    <FormField
                        label="Endpoint"
                        constraintText="Pinned to the endpoint referenced by the parent agent"
                    >
                        <Box padding={{ top: "xxs" }}>
                            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                                <Box variant="awsui-key-label" display="inline">
                                    {current.pinnedEndpoint}
                                </Box>
                                {selectedVersion && (
                                    <Box color="text-status-inactive" display="inline">
                                        (v{selectedVersion})
                                    </Box>
                                )}
                            </SpaceBetween>
                        </Box>
                    </FormField>
                ) : (
                    <FormField label="Version" constraintText="Select version to view details">
                        <Select
                            selectedOption={
                                selectedVersion
                                    ? (() => {
                                          const foundVersion = current?.versions.find(
                                              (v) => v.version === selectedVersion,
                                          );
                                          const hasQualifiers =
                                              foundVersion?.qualifiers &&
                                              foundVersion.qualifiers.length > 0;
                                          return {
                                              label: hasQualifiers
                                                  ? `${selectedVersion} (${foundVersion!.qualifiers.join(", ")})`
                                                  : selectedVersion,
                                              value: selectedVersion,
                                          };
                                      })()
                                    : null
                            }
                            onChange={({ detail }) =>
                                handleVersionChange(detail.selectedOption?.value || "")
                            }
                            options={(current?.versions ?? []).map((v) => ({
                                label:
                                    v.qualifiers.length > 0
                                        ? `${v.version} (${v.qualifiers.join(", ")})`
                                        : v.version,
                                value: v.version,
                            }))}
                            placeholder="Select version"
                        />
                    </FormField>
                )}

                {current?.error && <Alert type="error">{current.error}</Alert>}

                {loadingConfig ? (
                    <Box textAlign="center">
                        <StatusIndicator type="loading">Loading configuration</StatusIndicator>
                    </Box>
                ) : agentConfig ? (
                    isSwarmConfig(agentConfig) ? (
                        <SpaceBetween direction="vertical" size="m">
                            <FormField label="Entry Agent">
                                <Box padding="m">{agentConfig.entryAgent}</Box>
                            </FormField>

                            <FormField label="AgentCore Memory">
                                <Box padding="m">{renderMemoryStatus(agentConfig.useMemory)}</Box>
                            </FormField>

                            {agentConfig.agents && agentConfig.agents.length > 0 && (
                                <FormField label="Inline Agents">
                                    <SpaceBetween direction="vertical" size="xs">
                                        {agentConfig.agents.map((inlineAgent, idx) => {
                                            const params =
                                                inlineAgent.modelInferenceParameters?.parameters;
                                            const inlineMcp = buildMcpItems(
                                                inlineAgent.mcpServers || [],
                                            );
                                            const inlineToolParams =
                                                inlineAgent.toolParameters || {};
                                            return (
                                                <ExpandableSection
                                                    key={idx}
                                                    variant="container"
                                                    headerText={inlineAgent.name}
                                                >
                                                    <SpaceBetween direction="vertical" size="m">
                                                        <ColumnLayout
                                                            columns={4}
                                                            variant="text-grid"
                                                        >
                                                            <div>
                                                                <Box variant="awsui-key-label">
                                                                    Model
                                                                </Box>
                                                                <Box>
                                                                    {getModelName(
                                                                        inlineAgent
                                                                            .modelInferenceParameters
                                                                            ?.modelId || "",
                                                                    )}
                                                                </Box>
                                                            </div>
                                                            <div>
                                                                <Box variant="awsui-key-label">
                                                                    Temperature
                                                                </Box>
                                                                <Box>
                                                                    {params?.temperature ?? "N/A"}
                                                                </Box>
                                                            </div>
                                                            <div>
                                                                <Box variant="awsui-key-label">
                                                                    Max Tokens
                                                                </Box>
                                                                <Box>
                                                                    {params?.maxTokens ?? "N/A"}
                                                                </Box>
                                                            </div>
                                                            <div>
                                                                <Box variant="awsui-key-label">
                                                                    Thinking
                                                                </Box>
                                                                <Box>
                                                                    {renderThinkingStatus(
                                                                        inlineAgent
                                                                            .modelInferenceParameters
                                                                            ?.reasoningBudget,
                                                                    )}
                                                                </Box>
                                                            </div>
                                                        </ColumnLayout>

                                                        <div>
                                                            <Box variant="awsui-key-label">
                                                                Tools
                                                            </Box>
                                                            <Box>
                                                                {inlineAgent.tools?.length > 0
                                                                    ? inlineAgent.tools.join(", ")
                                                                    : "None"}
                                                            </Box>
                                                        </div>

                                                        {inlineMcp.length > 0 && (
                                                            <div>
                                                                <Box variant="awsui-key-label">
                                                                    MCP Servers
                                                                </Box>
                                                                <Table
                                                                    variant="embedded"
                                                                    items={inlineMcp}
                                                                    columnDefinitions={
                                                                        mcpServerColumns
                                                                    }
                                                                />
                                                            </div>
                                                        )}

                                                        {Object.keys(inlineToolParams).length >
                                                            0 && (
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
                                                                            inlineAgent.instructions ||
                                                                            ""
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

                            {agentConfig.agentReferences &&
                                agentConfig.agentReferences.length > 0 && (
                                    <FormField label="Agent References">
                                        <Table
                                            items={agentConfig.agentReferences}
                                            columnDefinitions={[
                                                {
                                                    id: "agentName",
                                                    header: "Agent Name",
                                                    cell: (item: any) =>
                                                        renderAgentRef(
                                                            item.agentName,
                                                            findRuntimeByName(item.agentName),
                                                            item.endpointName,
                                                        ),
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
                    ) : isAgentsAsTools ? (
                        <SpaceBetween direction="vertical" size="m">
                            <FormField label="Model Configuration">
                                <Box padding="m">
                                    <ColumnLayout columns={4} variant="text-grid">
                                        <div>
                                            <Box variant="awsui-key-label">Model</Box>
                                            <Box>
                                                {getModelName(
                                                    agentConfig.modelInferenceParameters?.modelId ||
                                                        "",
                                                )}
                                            </Box>
                                        </div>
                                        <div>
                                            <Box variant="awsui-key-label">Temperature</Box>
                                            <Box>
                                                {agentConfig.modelInferenceParameters?.parameters
                                                    ?.temperature ?? "N/A"}
                                            </Box>
                                        </div>
                                        <div>
                                            <Box variant="awsui-key-label">Max Tokens</Box>
                                            <Box>
                                                {agentConfig.modelInferenceParameters?.parameters
                                                    ?.maxTokens ?? "N/A"}
                                            </Box>
                                        </div>
                                        <div>
                                            <Box variant="awsui-key-label">Thinking</Box>
                                            <Box>
                                                {renderThinkingStatus(
                                                    agentConfig.modelInferenceParameters
                                                        ?.reasoningBudget,
                                                )}
                                            </Box>
                                        </div>
                                    </ColumnLayout>
                                </Box>
                            </FormField>

                            <FormField label="AgentCore Memory">
                                <Box padding="m">{renderMemoryStatus(agentConfig.useMemory)}</Box>
                            </FormField>

                            <FormField
                                label={
                                    <SpaceBetween
                                        direction="horizontal"
                                        size="xs"
                                        alignItems="center"
                                    >
                                        <span>Orchestrator Instructions</span>
                                        <CopyToClipboard
                                            textToCopy={agentConfig.instructions || ""}
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
                                            {agentConfig.instructions}
                                        </pre>
                                    </Box>
                                </ExpandableSection>
                            </FormField>

                            {agentConfig.agentsAsTools && agentConfig.agentsAsTools.length > 0 && (
                                <FormField label="Agents as Tools">
                                    <Table
                                        items={agentConfig.agentsAsTools}
                                        columnDefinitions={[
                                            {
                                                id: "agentName",
                                                header: "Agent",
                                                cell: (item: any) =>
                                                    renderAgentRef(
                                                        getAgentNameByRuntimeId(item.runtimeId),
                                                        findRuntimeById(item.runtimeId),
                                                        item.endpoint,
                                                    ),
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

                            {agentConfig.tools && agentConfig.tools.length > 0 && (
                                <FormField label="Additional Tools">
                                    <Table
                                        items={agentConfig.tools.map((toolName: string) => ({
                                            name: toolName,
                                            parameters:
                                                agentConfig.toolParameters?.[toolName] || {},
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
                                                        return (
                                                            <Box color="text-status-inactive">
                                                                None
                                                            </Box>
                                                        );
                                                    }
                                                    return renderValue(item.parameters);
                                                },
                                            },
                                        ]}
                                    />
                                </FormField>
                            )}

                            {agentConfig.mcpServers && agentConfig.mcpServers.length > 0 && (
                                <FormField label="MCP Servers">
                                    <Table
                                        items={buildMcpItems(agentConfig.mcpServers)}
                                        columnDefinitions={mcpServerColumns}
                                    />
                                </FormField>
                            )}

                            {agentConfig.conversationManager && (
                                <FormField label="Conversation Manager">
                                    <Box padding="m">{agentConfig.conversationManager}</Box>
                                </FormField>
                            )}
                        </SpaceBetween>
                    ) : isGraphConfig(agentConfig) ? (
                        <SpaceBetween direction="vertical" size="m">
                            <FormField label="Entry Point">
                                <Box padding="m">{agentConfig.entryPoint}</Box>
                            </FormField>

                            <FormField label="AgentCore Memory">
                                <Box padding="m">{renderMemoryStatus(agentConfig.useMemory)}</Box>
                            </FormField>

                            {agentConfig.nodes && agentConfig.nodes.length > 0 && (
                                <FormField label="Graph Nodes">
                                    <Table
                                        items={agentConfig.nodes}
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
                                                        renderAgentRef(
                                                            item.agentName,
                                                            findRuntimeByName(item.agentName),
                                                            item.endpointName,
                                                        )
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
                                                                WebkitBoxOrient:
                                                                    "vertical" as const,
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

                            {agentConfig.edges && agentConfig.edges.length > 0 && (
                                <FormField label="Edges">
                                    <Table
                                        items={agentConfig.edges}
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
                                    {agentConfig.stateClass ? (
                                        <div>
                                            <Box variant="awsui-key-label">State Class</Box>
                                            <Box>{agentConfig.stateClass}</Box>
                                        </div>
                                    ) : agentConfig.stateSchema &&
                                      Object.keys(agentConfig.stateSchema).length > 0 ? (
                                        <SpaceBetween direction="vertical" size="xs">
                                            {Object.entries(agentConfig.stateSchema).map(
                                                ([key, type]) => (
                                                    <Box key={key}>
                                                        <Box
                                                            variant="awsui-key-label"
                                                            display="inline"
                                                        >
                                                            {key}:
                                                        </Box>{" "}
                                                        <Box display="inline">{String(type)}</Box>
                                                    </Box>
                                                ),
                                            )}
                                        </SpaceBetween>
                                    ) : (
                                        <Box color="text-status-inactive">Not configured</Box>
                                    )}
                                </Box>
                            </FormField>

                            <FormField label="Graph Topology">
                                <GraphMinimap
                                    graphConfig={{
                                        nodes: agentConfig.nodes || [],
                                        edges: agentConfig.edges || [],
                                        entryPoint: agentConfig.entryPoint,
                                        stateSchema: agentConfig.stateSchema || {},
                                        stateClass: agentConfig.stateClass,
                                        orchestrator: agentConfig.orchestrator || {
                                            maxIterations: 50,
                                            executionTimeoutSeconds: 300,
                                            nodeTimeoutSeconds: 60,
                                        },
                                    }}
                                />
                            </FormField>

                            {agentConfig.orchestrator && (
                                <FormField label="Orchestrator Settings">
                                    <Box padding="m">
                                        <ColumnLayout columns={3} variant="text-grid">
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
                        </SpaceBetween>
                    ) : (
                        <SpaceBetween direction="vertical" size="m">
                            <FormField label="Model Configuration">
                                <Box padding="m">
                                    <ColumnLayout columns={4} variant="text-grid">
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
                                        <div>
                                            <Box variant="awsui-key-label">Thinking</Box>
                                            <Box>
                                                {renderThinkingStatus(
                                                    agentConfig.modelInferenceParameters
                                                        .reasoningBudget,
                                                )}
                                            </Box>
                                        </div>
                                    </ColumnLayout>
                                </Box>
                            </FormField>

                            <FormField label="AgentCore Memory">
                                <Box padding="m">{renderMemoryStatus(agentConfig.useMemory)}</Box>
                            </FormField>

                            <FormField
                                label="Agent Description"
                                description="Capability blurb published in this agent's A2A agent card."
                            >
                                <Box padding="m">
                                    {agentConfig.description || (
                                        <Box color="text-status-inactive">Not set</Box>
                                    )}
                                </Box>
                            </FormField>

                            <FormField
                                label={
                                    <SpaceBetween
                                        direction="horizontal"
                                        size="xs"
                                        alignItems="center"
                                    >
                                        <span>Agent Instructions</span>
                                        <CopyToClipboard
                                            textToCopy={agentConfig.instructions}
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
                                            {agentConfig.instructions}
                                        </pre>
                                    </Box>
                                </ExpandableSection>
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
                                                            <Box color="text-status-inactive">
                                                                None
                                                            </Box>
                                                        );
                                                    }
                                                    return renderValue(item.parameters);
                                                },
                                            },
                                        ]}
                                    />
                                </FormField>
                            )}

                            {agentConfig.skills && agentConfig.skills.length > 0 && (
                                <FormField label="Skills">
                                    <Box padding="m">{agentConfig.skills.join(", ")}</Box>
                                </FormField>
                            )}

                            {mcpServerTableItems.length > 0 && (
                                <FormField label="MCP Servers">
                                    <Table
                                        items={mcpServerTableItems}
                                        columnDefinitions={mcpServerColumns}
                                    />
                                </FormField>
                            )}

                            <FormField label="Structured Output">
                                {Array.isArray(agentConfig.structuredOutput) &&
                                agentConfig.structuredOutput.length > 0 ? (
                                    <Table
                                        items={agentConfig.structuredOutput}
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
                                                        <StatusIndicator type="info">
                                                            Yes
                                                        </StatusIndicator>
                                                    ) : (
                                                        <StatusIndicator type="stopped">
                                                            No
                                                        </StatusIndicator>
                                                    ),
                                            },
                                        ]}
                                    />
                                ) : (
                                    <Box padding="m">
                                        <StatusIndicator type="stopped">
                                            Not configured
                                        </StatusIndicator>
                                    </Box>
                                )}
                            </FormField>

                            {agentConfig.conversationManager && (
                                <FormField label="Conversation Manager">
                                    <Box padding="m">{agentConfig.conversationManager}</Box>
                                </FormField>
                            )}
                        </SpaceBetween>
                    )
                ) : null}
            </SpaceBetween>
        </Modal>
    );
}
