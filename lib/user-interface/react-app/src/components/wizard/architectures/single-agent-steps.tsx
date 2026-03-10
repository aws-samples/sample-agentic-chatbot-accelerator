// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Container,
    FormField,
    Header,
    Icon,
    Input,
    Popover,
    Select,
    SpaceBetween,
    Table,
    Textarea,
} from "@cloudscape-design/components";
import ReactMarkdown from "react-markdown";
import { KnowledgeBase, McpServer, Tool } from "../../../API";
import { AgentCoreRuntimeConfiguration } from "../types";
import { CONVERSATION_MANAGER_OPTIONS, STEP_MIN_HEIGHT } from "../wizard-utils";

interface SingleAgentStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    modelOptions: { label: string; value: string }[];
    availableTools: Tool[];
    availableMcpServers: McpServer[];
    knowledgeBases: KnowledgeBase[];
    knowledgeBaseIsSupported: boolean;
    isCreating: boolean;
    openConfigureModal: (toolName: string) => void;
}

export function getSingleAgentSteps({
    config,
    setConfig,
    modelOptions,
    availableTools,
    availableMcpServers,
    knowledgeBases,
    knowledgeBaseIsSupported,
    isCreating,
    openConfigureModal,
}: SingleAgentStepsProps) {
    // -------------------------------------------------------------------
    // Tool / KB / MCP actions
    // -------------------------------------------------------------------
    const addTool = (toolName: string | undefined) => {
        if (!toolName || toolName === "retrieve_from_kb" || config.tools.includes(toolName)) return;
        setConfig((prev) => ({
            ...prev,
            tools: [...prev.tools, toolName],
            toolParameters: { ...prev.toolParameters, [toolName]: {} },
        }));
    };

    const removeTool = (toolName: string) => {
        setConfig((prev) => {
            const newToolParameters = { ...prev.toolParameters };
            delete newToolParameters[toolName];
            return {
                ...prev,
                tools: prev.tools.filter((t) => t !== toolName),
                toolParameters: newToolParameters,
            };
        });
    };

    const addMcpServer = (serverName: string | undefined) => {
        if (!serverName || config.mcpServers.includes(serverName)) return;
        setConfig((prev) => ({ ...prev, mcpServers: [...prev.mcpServers, serverName] }));
    };

    const removeMcpServer = (serverName: string) => {
        setConfig((prev) => ({
            ...prev,
            mcpServers: prev.mcpServers.filter((s) => s !== serverName),
        }));
    };

    const addKnowledgeBase = (kbId: string | undefined) => {
        if (!kbId) return;
        const toolName = `retrieve_from_kb_${kbId}`;
        if (config.tools.includes(toolName)) return;
        setConfig((prev) => ({
            ...prev,
            tools: [...prev.tools, toolName],
            toolParameters: {
                ...prev.toolParameters,
                [toolName]: {
                    retrieval_cfg: { vectorSearchConfiguration: { numberOfResults: "5" } },
                    kb_id: kbId,
                },
            },
        }));
    };

    // -------------------------------------------------------------------
    // Derived display data
    // -------------------------------------------------------------------
    const availableToolsOptions = availableTools
        .filter((tool) => !tool.invokesSubAgent && !config.tools.includes(tool.name))
        .map((tool) => ({
            label: tool.name,
            value: tool.name,
            description: tool.description || undefined,
        }));

    const availableMcpServersOptions = availableMcpServers
        .filter((s) => !config.mcpServers.includes(s.name))
        .map((s) => ({ label: s.name, value: s.name, description: s.description || undefined }));

    const availableKnowledgeBasesOptions = knowledgeBases
        .filter((kb) => !config.tools.some((tool) => tool === `retrieve_from_kb_${kb.id}`))
        .map((kb) => ({ label: kb.description || kb.name, value: kb.id }));

    const selectedToolsData = config.tools
        .filter((t) => !t.startsWith("retrieve_from_kb_") && !t.startsWith("invoke_subagent_"))
        .map((toolName) => {
            const toolInfo = availableTools.find((t) => t.name === toolName);
            return {
                name: toolName,
                description: toolInfo?.description || "No description available",
            };
        });

    const selectedMcpServersData = config.mcpServers.map((serverName) => {
        const serverInfo = availableMcpServers.find((s) => s.name === serverName);
        return {
            name: serverName,
            description: serverInfo?.description || "No description available",
            mcpUrl: serverInfo?.mcpUrl || "",
        };
    });

    const selectedKnowledgeBasesData = config.tools
        .filter((t) => t.startsWith("retrieve_from_kb_"))
        .map((toolName) => {
            const kbId = toolName.replace("retrieve_from_kb_", "");
            const kb = knowledgeBases.find((k) => k.id === kbId);
            const params = config.toolParameters[toolName];
            return {
                toolName,
                name: kb?.name || kbId,
                description: kb?.description || "No description available",
                numberOfResults:
                    params?.retrieval_cfg?.vectorSearchConfiguration?.numberOfResults || "5",
            };
        });

    // -------------------------------------------------------------------
    // Steps
    // -------------------------------------------------------------------
    const steps = [
        {
            title: "Basic Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Agent Instructions</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="Agent Name"
                                description="Enter a unique name for your agent"
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
                                        setConfig((prev) => ({ ...prev, agentName: detail.value }))
                                    }
                                    placeholder="Enter agent name..."
                                    invalid={config.agentName.trim() === ""}
                                />
                            </FormField>
                            <FormField
                                label="Instructions"
                                description="Provide detailed instructions for your agent"
                                errorText={
                                    config.instructions.trim() === ""
                                        ? "Instructions are required"
                                        : ""
                                }
                            >
                                <Textarea
                                    value={config.instructions}
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            instructions: detail.value,
                                        }))
                                    }
                                    placeholder="Enter agent instructions..."
                                    rows={8}
                                    invalid={config.instructions.trim() === ""}
                                />
                            </FormField>
                            <FormField label="Conversation Manager">
                                <Select
                                    selectedOption={
                                        CONVERSATION_MANAGER_OPTIONS.find(
                                            (opt) => opt.value === config.conversationManager,
                                        ) || null
                                    }
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            conversationManager: (detail.selectedOption?.value ||
                                                "sliding_window") as
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
                </div>
            ),
        },
        {
            title: "Model Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Model & Parameters</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField label="Model">
                                <Select
                                    selectedOption={
                                        modelOptions.find(
                                            (opt) =>
                                                opt.value ===
                                                config.modelInferenceParameters.modelId,
                                        ) || null
                                    }
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            modelInferenceParameters: {
                                                ...prev.modelInferenceParameters,
                                                modelId: detail.selectedOption?.value || "",
                                            },
                                        }))
                                    }
                                    options={modelOptions}
                                />
                            </FormField>
                            <FormField label="Temperature" description="Value between 0 and 1">
                                <Input
                                    value={config.modelInferenceParameters.parameters.temperature.toString()}
                                    onChange={({ detail }) => {
                                        const value = parseFloat(detail.value) || 0;
                                        if (value >= 0 && value <= 1) {
                                            setConfig((prev) => ({
                                                ...prev,
                                                modelInferenceParameters: {
                                                    ...prev.modelInferenceParameters,
                                                    parameters: {
                                                        ...prev.modelInferenceParameters.parameters,
                                                        temperature: value,
                                                    },
                                                },
                                            }));
                                        }
                                    }}
                                    type="number"
                                    step={0.05}
                                />
                            </FormField>
                            <FormField label="Max Tokens" description="Value between 100 and 4000">
                                <Input
                                    value={config.modelInferenceParameters.parameters.maxTokens.toString()}
                                    onChange={({ detail }) => {
                                        const value = parseInt(detail.value) || 100;
                                        if (value >= 100 && value <= 4000) {
                                            setConfig((prev) => ({
                                                ...prev,
                                                modelInferenceParameters: {
                                                    ...prev.modelInferenceParameters,
                                                    parameters: {
                                                        ...prev.modelInferenceParameters.parameters,
                                                        maxTokens: value,
                                                    },
                                                },
                                            }));
                                        }
                                    }}
                                    type="number"
                                    step={100}
                                />
                            </FormField>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Memory Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Memory Settings</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="AgentCore Memory"
                                description="Create an AgentCore Memory and attach it to your agent Runtime."
                            >
                                <Checkbox
                                    checked={config.useMemory || false}
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            useMemory: detail.checked,
                                        }))
                                    }
                                >
                                    Enable AgentCore Memory
                                </Checkbox>
                            </FormField>
                            {config.useMemory && (
                                <Alert type="info" header="AgentCore Memory Enabled">
                                    AgentCore Memory will be created and attached to your agent
                                    Runtime. This allows the agent to maintain conversation context
                                    even when sessions are terminated (due to inactivity or reaching
                                    max duration).
                                </Alert>
                            )}
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Tools Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Configure Tools</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField label="Available Tools">
                                <Select
                                    placeholder={
                                        availableToolsOptions.length === 0
                                            ? "No additional tools available"
                                            : "Select a tool to add"
                                    }
                                    options={availableToolsOptions}
                                    disabled={availableToolsOptions.length === 0}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption) {
                                            addTool(detail.selectedOption.value);
                                        }
                                    }}
                                    selectedOption={null}
                                />
                            </FormField>

                            <Container header={<Header variant="h3">Selected Tools</Header>}>
                                {selectedToolsData.length === 0 ? (
                                    <Alert type="info">No tools selected</Alert>
                                ) : (
                                    <Table
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Tool Name",
                                                cell: (item) => item.name,
                                            },
                                            {
                                                id: "description",
                                                header: "Description",
                                                cell: (item) => (
                                                    <Popover
                                                        dismissButton={false}
                                                        position="top"
                                                        size="medium"
                                                        triggerType="custom"
                                                        content={
                                                            <Box padding="xs">
                                                                <ReactMarkdown>
                                                                    {item.description}
                                                                </ReactMarkdown>
                                                            </Box>
                                                        }
                                                    >
                                                        <Icon name="status-info" />
                                                    </Popover>
                                                ),
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() => removeTool(item.name)}
                                                    />
                                                ),
                                            },
                                        ]}
                                        items={selectedToolsData}
                                        loadingText="Loading tools"
                                        empty={
                                            <Box textAlign="center" color="inherit">
                                                <b>No tools selected</b>
                                                <Box
                                                    padding={{ bottom: "s" }}
                                                    variant="p"
                                                    color="inherit"
                                                >
                                                    Select tools from the dropdown above.
                                                </Box>
                                            </Box>
                                        }
                                    />
                                )}
                            </Container>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "MCP Servers Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Configure MCP Servers</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="Available MCP Servers"
                                description="Model Context Protocol servers provide additional capabilities to your agent"
                            >
                                <Select
                                    placeholder={
                                        availableMcpServersOptions.length === 0
                                            ? "No MCP servers available"
                                            : "Select an MCP server to add"
                                    }
                                    options={availableMcpServersOptions}
                                    disabled={availableMcpServersOptions.length === 0}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption) {
                                            addMcpServer(detail.selectedOption.value);
                                        }
                                    }}
                                    selectedOption={null}
                                />
                            </FormField>

                            <Container header={<Header variant="h3">Selected MCP Servers</Header>}>
                                {selectedMcpServersData.length === 0 ? (
                                    <Alert type="info">No MCP servers selected</Alert>
                                ) : (
                                    <Table
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Server Name",
                                                cell: (item) => item.name,
                                            },
                                            {
                                                id: "description",
                                                header: "Description",
                                                cell: (item) => (
                                                    <Popover
                                                        dismissButton={false}
                                                        position="top"
                                                        size="medium"
                                                        triggerType="custom"
                                                        content={
                                                            <Box padding="xs">
                                                                <ReactMarkdown>
                                                                    {item.description}
                                                                </ReactMarkdown>
                                                            </Box>
                                                        }
                                                    >
                                                        <Icon name="status-info" />
                                                    </Popover>
                                                ),
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() => removeMcpServer(item.name)}
                                                    />
                                                ),
                                            },
                                        ]}
                                        items={selectedMcpServersData}
                                        loadingText="Loading MCP servers"
                                        empty={
                                            <Box textAlign="center" color="inherit">
                                                <b>No MCP servers selected</b>
                                                <Box
                                                    padding={{ bottom: "s" }}
                                                    variant="p"
                                                    color="inherit"
                                                >
                                                    Select MCP servers from the dropdown above.
                                                </Box>
                                            </Box>
                                        }
                                    />
                                )}
                            </Container>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
    ];

    // Conditionally add Knowledge Bases step
    if (knowledgeBaseIsSupported) {
        steps.push({
            title: "Knowledge Bases",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Configure Knowledge Bases</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField label="Available Knowledge Bases">
                                <Select
                                    placeholder={
                                        availableKnowledgeBasesOptions.length === 0
                                            ? "No additional knowledge bases available"
                                            : "Select a knowledge base to add"
                                    }
                                    options={availableKnowledgeBasesOptions}
                                    disabled={availableKnowledgeBasesOptions.length === 0}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption) {
                                            addKnowledgeBase(detail.selectedOption.value);
                                        }
                                    }}
                                    selectedOption={null}
                                />
                            </FormField>

                            <Container
                                header={<Header variant="h3">Selected Knowledge Bases</Header>}
                            >
                                {selectedKnowledgeBasesData.length === 0 ? (
                                    <Alert type="info">No knowledge bases selected</Alert>
                                ) : (
                                    <Table
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Knowledge Base",
                                                cell: (item) => item.name,
                                            },
                                            {
                                                id: "description",
                                                header: "Description",
                                                cell: (item) => (
                                                    <Popover
                                                        dismissButton={false}
                                                        position="top"
                                                        size="medium"
                                                        triggerType="custom"
                                                        content={
                                                            <Box padding="xs">
                                                                <ReactMarkdown>
                                                                    {item.description}
                                                                </ReactMarkdown>
                                                            </Box>
                                                        }
                                                    >
                                                        <Icon name="status-info" />
                                                    </Popover>
                                                ),
                                            },
                                            {
                                                id: "parameters",
                                                header: "Parameters",
                                                cell: (item) => (
                                                    <Button
                                                        variant="normal"
                                                        onClick={() =>
                                                            openConfigureModal(item.toolName)
                                                        }
                                                    >
                                                        Configure
                                                    </Button>
                                                ),
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: (item) => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() => removeTool(item.toolName)}
                                                    />
                                                ),
                                            },
                                        ]}
                                        items={selectedKnowledgeBasesData}
                                        loadingText="Loading knowledge bases"
                                        empty={
                                            <Box textAlign="center" color="inherit">
                                                <b>No knowledge bases selected</b>
                                                <Box
                                                    padding={{ bottom: "s" }}
                                                    variant="p"
                                                    color="inherit"
                                                >
                                                    Select knowledge bases from the dropdown above.
                                                </Box>
                                            </Box>
                                        }
                                    />
                                )}
                            </Container>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        });
    }

    // Review step
    steps.push({
        title: "Review",
        content: (
            <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                <Container header={<Header variant="h2">Review Configuration</Header>}>
                    <SpaceBetween direction="vertical" size="m">
                        {!isCreating && (
                            <Alert type="info" header="Configuration Summary">
                                Review your agent configuration before creating.
                            </Alert>
                        )}
                        <Box padding="m" variant="code">
                            <pre style={{ margin: 0, overflow: "auto" }}>
                                {JSON.stringify(config, null, 2)}
                            </pre>
                        </Box>
                    </SpaceBetween>
                </Container>
            </div>
        ),
    });

    return steps;
}

/** Validate a single-agent step */
export function isSingleAgentStepValid(
    stepIndex: number,
    config: AgentCoreRuntimeConfiguration,
): boolean {
    // stepIndex is relative to the architecture-specific steps (0 = Basic Config, etc.)
    if (stepIndex === 0) {
        const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
        return (
            config.instructions.trim() !== "" &&
            config.agentName.trim() !== "" &&
            agentNamePattern.test(config.agentName)
        );
    }
    return true;
}
