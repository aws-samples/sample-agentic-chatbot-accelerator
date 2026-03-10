// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    ColumnLayout,
    Container,
    FormField,
    Header,
    Input,
    Select,
    SpaceBetween,
    Table,
    Textarea,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import {
    AgentAsToolDefinition,
    AgentCoreRuntimeConfiguration,
    AgentsAsToolsConfiguration,
} from "../types";
import { CONVERSATION_MANAGER_OPTIONS, STEP_MIN_HEIGHT } from "../wizard-utils";

export interface AgentsAsToolsStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    agentsAsToolsConfig: AgentsAsToolsConfiguration;
    setAgentsAsToolsConfig: React.Dispatch<React.SetStateAction<AgentsAsToolsConfiguration>>;
    availableAgents: RuntimeSummary[];
    modelOptions: { label: string; value: string }[];
    availableToolsOptions: { label: string; value: string; description?: string }[];
    availableMcpServersOptions: { label: string; value: string; description?: string }[];
    availableKnowledgeBases: { label: string; value: string }[];
    knowledgeBaseIsSupported: boolean;
    isCreating: boolean;
}

/** Helper to get endpoint options for an agent from qualifierToVersion */
function getEndpointOptions(agentName: string, availableAgents: RuntimeSummary[]) {
    const agent = availableAgents.find((a) => a.agentName === agentName);
    const options: { label: string; value: string }[] = [];
    if (agent?.qualifierToVersion) {
        try {
            const qtv = JSON.parse(agent.qualifierToVersion);
            if (qtv && typeof qtv === "object") {
                options.push(
                    ...Object.keys(qtv).map((key) => ({
                        label: key,
                        value: key,
                    })),
                );
            }
        } catch {
            // ignore parse errors
        }
    }
    if (!options.some((o) => o.value === "DEFAULT")) {
        options.unshift({ label: "DEFAULT", value: "DEFAULT" });
    }
    return options;
}

export function getAgentsAsToolsSteps({
    config,
    setConfig,
    agentsAsToolsConfig,
    setAgentsAsToolsConfig,
    availableAgents,
    modelOptions,
    availableToolsOptions,
    availableMcpServersOptions,
    availableKnowledgeBases,
    knowledgeBaseIsSupported,
    isCreating,
}: AgentsAsToolsStepsProps) {
    // -------------------------------------------------------------------
    // Agent-tool management
    // -------------------------------------------------------------------
    const addAgentAsTool = (agentName: string) => {
        const agent = availableAgents.find((a) => a.agentName === agentName);
        if (!agent) return;
        // Prevent duplicates
        if (agentsAsToolsConfig.agentsAsTools.some((a) => a.runtimeId === agent.agentRuntimeId))
            return;

        const newTool: AgentAsToolDefinition = {
            runtimeId: agent.agentRuntimeId,
            endpoint: "DEFAULT",
            role: "",
        };

        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            agentsAsTools: [...prev.agentsAsTools, newTool],
        }));
    };

    const removeAgentAsTool = (index: number) => {
        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            agentsAsTools: prev.agentsAsTools.filter((_, i) => i !== index),
        }));
    };

    const updateAgentToolEndpoint = (index: number, endpoint: string) => {
        setAgentsAsToolsConfig((prev) => {
            const updated = [...prev.agentsAsTools];
            updated[index] = { ...updated[index], endpoint };
            return { ...prev, agentsAsTools: updated };
        });
    };

    const updateAgentToolRole = (index: number, role: string) => {
        setAgentsAsToolsConfig((prev) => {
            const updated = [...prev.agentsAsTools];
            updated[index] = { ...updated[index], role };
            return { ...prev, agentsAsTools: updated };
        });
    };

    /** Resolve runtimeId back to agentName for display */
    const getAgentNameByRuntimeId = (runtimeId: string): string => {
        const agent = availableAgents.find((a) => a.agentRuntimeId === runtimeId);
        return agent?.agentName || runtimeId;
    };

    // -------------------------------------------------------------------
    // Tool management for the orchestrator
    // -------------------------------------------------------------------
    const addOrchestratorTool = (toolName: string | undefined) => {
        if (!toolName) return;
        const current = agentsAsToolsConfig.tools || [];
        if (current.includes(toolName)) return;
        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            tools: [...(prev.tools || []), toolName],
            toolParameters: { ...(prev.toolParameters || {}), [toolName]: {} },
        }));
    };

    const removeOrchestratorTool = (toolName: string) => {
        setAgentsAsToolsConfig((prev) => {
            const newToolParams = { ...(prev.toolParameters || {}) };
            delete newToolParams[toolName];
            return {
                ...prev,
                tools: (prev.tools || []).filter((t) => t !== toolName),
                toolParameters: newToolParams,
            };
        });
    };

    const addOrchestratorKnowledgeBase = (kbId: string | undefined) => {
        if (!kbId) return;
        const toolName = `retrieve_from_kb_${kbId}`;
        const current = agentsAsToolsConfig.tools || [];
        if (current.includes(toolName)) return;
        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            tools: [...(prev.tools || []), toolName],
            toolParameters: {
                ...(prev.toolParameters || {}),
                [toolName]: {
                    retrieval_cfg: { vectorSearchConfiguration: { numberOfResults: "5" } },
                    kb_id: kbId,
                },
            },
        }));
    };

    const addOrchestratorMcpServer = (serverName: string | undefined) => {
        if (!serverName) return;
        const current = agentsAsToolsConfig.mcpServers || [];
        if (current.includes(serverName)) return;
        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            mcpServers: [...(prev.mcpServers || []), serverName],
        }));
    };

    const removeOrchestratorMcpServer = (serverName: string) => {
        setAgentsAsToolsConfig((prev) => ({
            ...prev,
            mcpServers: (prev.mcpServers || []).filter((s) => s !== serverName),
        }));
    };

    // Derive filtered tool options (exclude already-selected tools and KB tools)
    const orchestratorTools = agentsAsToolsConfig.tools || [];
    const filteredToolOptions = availableToolsOptions.filter(
        (t) => !orchestratorTools.includes(t.value),
    );
    const filteredKbOptions = knowledgeBaseIsSupported
        ? availableKnowledgeBases.filter(
              (kb) => !orchestratorTools.includes(`retrieve_from_kb_${kb.value}`),
          )
        : [];
    const orchestratorMcpServers = agentsAsToolsConfig.mcpServers || [];
    const filteredMcpOptions = availableMcpServersOptions.filter(
        (s) => !orchestratorMcpServers.includes(s.value),
    );

    // Build the serialization preview (clean version matching backend expectations)
    const buildPreviewConfig = () => {
        const preview: Record<string, any> = {
            agentsAsTools: agentsAsToolsConfig.agentsAsTools,
            modelInferenceParameters: agentsAsToolsConfig.modelInferenceParameters,
            instructions: agentsAsToolsConfig.instructions,
            conversationManager: agentsAsToolsConfig.conversationManager,
        };
        if (orchestratorTools.length > 0) {
            preview.tools = orchestratorTools;
            preview.toolParameters = agentsAsToolsConfig.toolParameters || {};
        }
        if (orchestratorMcpServers.length > 0) {
            preview.mcpServers = orchestratorMcpServers;
        }
        return preview;
    };

    return [
        // Step 1: Agents as Tools Configuration
        {
            title: "Agents as Tools",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <Container header={<Header variant="h2">Agent Name</Header>}>
                            <FormField
                                label="Agent Name"
                                description="Enter a unique name for your agents-as-tools orchestrator"
                                errorText={
                                    config.agentName.trim() === ""
                                        ? "Agent name is required"
                                        : !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(config.agentName)
                                          ? "Agent name must start with a letter and contain only letters, numbers, and underscores (max 48 characters)"
                                          : ""
                                }
                            >
                                <Input
                                    value={config.agentName}
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            agentName: detail.value,
                                        }))
                                    }
                                    placeholder="Enter agent name..."
                                    invalid={config.agentName.trim() === ""}
                                />
                            </FormField>
                        </Container>

                        <Container
                            header={
                                <Header
                                    variant="h2"
                                    description="Select existing agents to expose as tools to the orchestrator. Each agent needs an endpoint and a role description."
                                >
                                    Sub-Agents as Tools
                                </Header>
                            }
                        >
                            <SpaceBetween direction="vertical" size="m">
                                <FormField
                                    label="Add Agent"
                                    description="Select an existing agent to add as a tool"
                                >
                                    <Select
                                        placeholder="Select an agent..."
                                        options={availableAgents
                                            .filter(
                                                (a) =>
                                                    a.agentName !== config.agentName &&
                                                    !agentsAsToolsConfig.agentsAsTools.some(
                                                        (t) => t.runtimeId === a.agentRuntimeId,
                                                    ),
                                            )
                                            .map((a) => ({
                                                label: a.agentName,
                                                value: a.agentName,
                                                description: a.architectureType || undefined,
                                            }))}
                                        onChange={({ detail }) => {
                                            if (detail.selectedOption?.value) {
                                                addAgentAsTool(detail.selectedOption.value);
                                            }
                                        }}
                                        selectedOption={null}
                                        filteringType="auto"
                                    />
                                </FormField>

                                {agentsAsToolsConfig.agentsAsTools.length === 0 ? (
                                    <Alert type="info">
                                        No agents added yet. Select an agent above to add it as a
                                        tool.
                                    </Alert>
                                ) : (
                                    <Table
                                        items={agentsAsToolsConfig.agentsAsTools.map((a, i) => ({
                                            ...a,
                                            _index: i,
                                        }))}
                                        columnDefinitions={[
                                            {
                                                id: "agentName",
                                                header: "Agent",
                                                cell: (item) => {
                                                    const name = getAgentNameByRuntimeId(
                                                        item.runtimeId,
                                                    );
                                                    const agent = availableAgents.find(
                                                        (a) => a.agentRuntimeId === item.runtimeId,
                                                    );
                                                    return (
                                                        <SpaceBetween
                                                            direction="horizontal"
                                                            size="xs"
                                                        >
                                                            <span>{name}</span>
                                                            {agent?.architectureType && (
                                                                <Box
                                                                    color="text-status-info"
                                                                    fontSize="body-s"
                                                                >
                                                                    ({agent.architectureType})
                                                                </Box>
                                                            )}
                                                        </SpaceBetween>
                                                    );
                                                },
                                                isRowHeader: true,
                                            },
                                            {
                                                id: "endpoint",
                                                header: "Endpoint",
                                                cell: (item) => {
                                                    const agentName = getAgentNameByRuntimeId(
                                                        item.runtimeId,
                                                    );
                                                    const options = getEndpointOptions(
                                                        agentName,
                                                        availableAgents,
                                                    );
                                                    return (
                                                        <Select
                                                            expandToViewport
                                                            selectedOption={
                                                                options.find(
                                                                    (o) =>
                                                                        o.value === item.endpoint,
                                                                ) || {
                                                                    label: item.endpoint,
                                                                    value: item.endpoint,
                                                                }
                                                            }
                                                            onChange={({ detail }) =>
                                                                updateAgentToolEndpoint(
                                                                    item._index,
                                                                    detail.selectedOption?.value ||
                                                                        "DEFAULT",
                                                                )
                                                            }
                                                            options={options}
                                                        />
                                                    );
                                                },
                                            },
                                            {
                                                id: "role",
                                                header: "Role",
                                                cell: (item) => (
                                                    <Textarea
                                                        value={item.role}
                                                        onChange={({ detail }) =>
                                                            updateAgentToolRole(
                                                                item._index,
                                                                detail.value,
                                                            )
                                                        }
                                                        placeholder="Describe the role of this agent..."
                                                        rows={2}
                                                    />
                                                ),
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() =>
                                                            removeAgentAsTool(item._index)
                                                        }
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                )}
                            </SpaceBetween>
                        </Container>
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 2: Orchestrator Configuration
        {
            title: "Orchestrator Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <Container header={<Header variant="h2">Model &amp; Instructions</Header>}>
                            <SpaceBetween direction="vertical" size="l">
                                <ColumnLayout columns={2} variant="text-grid">
                                    <FormField
                                        label="Model"
                                        description="Select the LLM model for the orchestrator"
                                    >
                                        <Select
                                            placeholder="Select a model..."
                                            options={modelOptions}
                                            selectedOption={
                                                modelOptions.find(
                                                    (m) =>
                                                        m.value ===
                                                        agentsAsToolsConfig.modelInferenceParameters
                                                            .modelId,
                                                ) || null
                                            }
                                            onChange={({ detail }) =>
                                                setAgentsAsToolsConfig((prev) => ({
                                                    ...prev,
                                                    modelInferenceParameters: {
                                                        ...prev.modelInferenceParameters,
                                                        modelId: detail.selectedOption?.value || "",
                                                    },
                                                }))
                                            }
                                            filteringType="auto"
                                        />
                                    </FormField>
                                    <SpaceBetween direction="vertical" size="s">
                                        <FormField
                                            label="Temperature"
                                            description="Controls randomness"
                                        >
                                            <Input
                                                type="number"
                                                value={agentsAsToolsConfig.modelInferenceParameters.parameters.temperature.toString()}
                                                onChange={({ detail }) =>
                                                    setAgentsAsToolsConfig((prev) => ({
                                                        ...prev,
                                                        modelInferenceParameters: {
                                                            ...prev.modelInferenceParameters,
                                                            parameters: {
                                                                ...prev.modelInferenceParameters
                                                                    .parameters,
                                                                temperature:
                                                                    parseFloat(detail.value) || 0.2,
                                                            },
                                                        },
                                                    }))
                                                }
                                            />
                                        </FormField>
                                        <FormField
                                            label="Max Tokens"
                                            description="Maximum output tokens"
                                        >
                                            <Input
                                                type="number"
                                                value={agentsAsToolsConfig.modelInferenceParameters.parameters.maxTokens.toString()}
                                                onChange={({ detail }) =>
                                                    setAgentsAsToolsConfig((prev) => ({
                                                        ...prev,
                                                        modelInferenceParameters: {
                                                            ...prev.modelInferenceParameters,
                                                            parameters: {
                                                                ...prev.modelInferenceParameters
                                                                    .parameters,
                                                                maxTokens:
                                                                    parseInt(detail.value) || 3000,
                                                            },
                                                        },
                                                    }))
                                                }
                                            />
                                        </FormField>
                                    </SpaceBetween>
                                </ColumnLayout>

                                <FormField
                                    label="Orchestrator Instructions"
                                    description="System prompt that defines how the orchestrator delegates to its sub-agent tools"
                                >
                                    <Textarea
                                        value={agentsAsToolsConfig.instructions}
                                        onChange={({ detail }) =>
                                            setAgentsAsToolsConfig((prev) => ({
                                                ...prev,
                                                instructions: detail.value,
                                            }))
                                        }
                                        placeholder="You are an orchestrator agent. You have access to the following sub-agents as tools..."
                                        rows={6}
                                    />
                                </FormField>

                                <FormField label="Conversation Manager">
                                    <Select
                                        selectedOption={
                                            CONVERSATION_MANAGER_OPTIONS.find(
                                                (opt) =>
                                                    opt.value ===
                                                    agentsAsToolsConfig.conversationManager,
                                            ) || null
                                        }
                                        onChange={({ detail }) =>
                                            setAgentsAsToolsConfig((prev) => ({
                                                ...prev,
                                                conversationManager: (detail.selectedOption
                                                    ?.value || "sliding_window") as
                                                    | "null"
                                                    | "sliding_window"
                                                    | "summarizing",
                                            }))
                                        }
                                        options={CONVERSATION_MANAGER_OPTIONS}
                                    />
                                </FormField>
                            </SpaceBetween>
                        </Container>

                        <Container
                            header={
                                <Header
                                    variant="h2"
                                    description="Optionally add tools, knowledge bases, and MCP servers available to the orchestrator (in addition to the sub-agent tools)"
                                >
                                    Additional Tools (Optional)
                                </Header>
                            }
                        >
                            <SpaceBetween direction="vertical" size="m">
                                <ColumnLayout columns={knowledgeBaseIsSupported ? 3 : 2}>
                                    <FormField label="Add Tool">
                                        <Select
                                            placeholder="Select a tool..."
                                            options={filteredToolOptions}
                                            onChange={({ detail }) =>
                                                addOrchestratorTool(detail.selectedOption?.value)
                                            }
                                            selectedOption={null}
                                            filteringType="auto"
                                        />
                                    </FormField>
                                    {knowledgeBaseIsSupported && (
                                        <FormField label="Add Knowledge Base">
                                            <Select
                                                placeholder="Select a KB..."
                                                options={filteredKbOptions}
                                                onChange={({ detail }) =>
                                                    addOrchestratorKnowledgeBase(
                                                        detail.selectedOption?.value,
                                                    )
                                                }
                                                selectedOption={null}
                                                filteringType="auto"
                                            />
                                        </FormField>
                                    )}
                                    <FormField label="Add MCP Server">
                                        <Select
                                            placeholder="Select MCP server..."
                                            options={filteredMcpOptions}
                                            onChange={({ detail }) =>
                                                addOrchestratorMcpServer(
                                                    detail.selectedOption?.value,
                                                )
                                            }
                                            selectedOption={null}
                                            filteringType="auto"
                                        />
                                    </FormField>
                                </ColumnLayout>

                                {orchestratorTools.length > 0 && (
                                    <Table
                                        items={orchestratorTools.map((t) => ({ name: t }))}
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Tool Name",
                                                cell: (item) => item.name,
                                                isRowHeader: true,
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() =>
                                                            removeOrchestratorTool(item.name)
                                                        }
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                )}

                                {orchestratorMcpServers.length > 0 && (
                                    <Table
                                        items={orchestratorMcpServers.map((s) => ({ name: s }))}
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "MCP Server",
                                                cell: (item) => item.name,
                                                isRowHeader: true,
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() =>
                                                            removeOrchestratorMcpServer(item.name)
                                                        }
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                )}

                                {orchestratorTools.length === 0 &&
                                    orchestratorMcpServers.length === 0 && (
                                        <Alert type="info">
                                            No additional tools or MCP servers configured. The
                                            orchestrator will only use the sub-agent tools defined
                                            in the previous step.
                                        </Alert>
                                    )}
                            </SpaceBetween>
                        </Container>
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 3: Review
        {
            title: "Review",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        {!isCreating && (
                            <Alert type="info" header="Configuration Summary">
                                Review your agents-as-tools configuration before creating.
                            </Alert>
                        )}

                        <Container header={<Header variant="h2">Sub-Agent Tools</Header>}>
                            {agentsAsToolsConfig.agentsAsTools.length === 0 ? (
                                <Box color="text-status-inactive">No sub-agents configured.</Box>
                            ) : (
                                <Table
                                    items={agentsAsToolsConfig.agentsAsTools}
                                    columnDefinitions={[
                                        {
                                            id: "agent",
                                            header: "Agent",
                                            cell: (item) => getAgentNameByRuntimeId(item.runtimeId),
                                            isRowHeader: true,
                                        },
                                        {
                                            id: "endpoint",
                                            header: "Endpoint",
                                            cell: (item) => item.endpoint,
                                        },
                                        {
                                            id: "role",
                                            header: "Role",
                                            cell: (item) =>
                                                item.role || (
                                                    <Box color="text-status-inactive">
                                                        Not specified
                                                    </Box>
                                                ),
                                        },
                                    ]}
                                />
                            )}
                        </Container>

                        <Container header={<Header variant="h2">Configuration JSON</Header>}>
                            <Box padding="m" variant="code">
                                <pre
                                    style={{
                                        margin: 0,
                                        overflow: "auto",
                                        maxHeight: "400px",
                                    }}
                                >
                                    {JSON.stringify(
                                        {
                                            agentName: config.agentName,
                                            architectureType: "AGENTS_AS_TOOLS",
                                            agentsAsToolsConfig: buildPreviewConfig(),
                                        },
                                        null,
                                        2,
                                    )}
                                </pre>
                            </Box>
                        </Container>
                    </SpaceBetween>
                </div>
            ),
        },
    ];
}

/** Validate an agents-as-tools step */
export function isAgentsAsToolsStepValid(
    stepIndex: number,
    config: AgentCoreRuntimeConfiguration,
    agentsAsToolsConfig: AgentsAsToolsConfiguration,
): boolean {
    const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

    // Step 0: Agents as Tools
    if (stepIndex === 0) {
        const hasAgentName =
            config.agentName.trim() !== "" && agentNamePattern.test(config.agentName);
        const hasAgentsAsTools = agentsAsToolsConfig.agentsAsTools.length > 0;
        const allHaveRoles = agentsAsToolsConfig.agentsAsTools.every((a) => a.role.trim() !== "");
        return hasAgentName && hasAgentsAsTools && allHaveRoles;
    }

    // Step 1: Orchestrator Configuration
    if (stepIndex === 1) {
        const hasModel = agentsAsToolsConfig.modelInferenceParameters.modelId.trim() !== "";
        const hasInstructions = agentsAsToolsConfig.instructions.trim() !== "";
        return hasModel && hasInstructions;
    }

    // Step 2: Review — always valid
    return true;
}
