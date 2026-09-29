// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    Container,
    FormField,
    Header,
    Select,
    SpaceBetween,
    Table,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import {
    AgentAsToolDefinition,
    AgentCoreRuntimeConfiguration,
    AgentsAsToolsConfiguration,
} from "../types";
import {
    AdditionalToolsSection,
    AgentConfigSection,
    AgentNameField,
} from "../wizard-shared-components";
import {
    bindModelParams,
    STEP_MIN_HEIGHT,
    isReasoningEffortAccepted,
    AGENT_NAME_MAX_LENGTH,
    agentNameError,
    toolSelectionActions,
} from "../wizard-utils";
import ReviewStep from "./review-step";
import { getEndpointOptions } from "../../../common/utils";

export interface AgentsAsToolsStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    agentsAsToolsConfig: AgentsAsToolsConfiguration;
    setAgentsAsToolsConfig: React.Dispatch<React.SetStateAction<AgentsAsToolsConfiguration>>;
    availableAgents: RuntimeSummary[];
    /** True while the runtime list is still loading — gates raw-ARN flash. */
    agentsLoading: boolean;
    modelOptions: { label: string; value: string }[];
    availableToolsOptions: { label: string; value: string; description?: string }[];
    availableMcpServersOptions: { label: string; value: string; description?: string }[];
    availableKnowledgeBases: { label: string; value: string }[];
    knowledgeBaseIsSupported: boolean;
    isCreating: boolean;
}

export function getAgentsAsToolsSteps({
    config,
    setConfig,
    agentsAsToolsConfig,
    setAgentsAsToolsConfig,
    availableAgents,
    agentsLoading,
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
    // A persisted runtimeId is either the HTTP id (just added) or the A2A twin
    // ARN (loaded from a saved config; rewritten by the AppSync resolver at save
    // time), so every lookup has to accept both shapes.
    const isRuntime = (agent: RuntimeSummary, runtimeId: string) =>
        agent.agentRuntimeId === runtimeId ||
        (!!agent.agentRuntimeArnA2A && agent.agentRuntimeArnA2A === runtimeId);

    const addAgentAsTool = (agentName: string) => {
        const agent = availableAgents.find((a) => a.agentName === agentName);
        if (!agent) return;
        if (agentsAsToolsConfig.agentsAsTools.some((a) => isRuntime(agent, a.runtimeId))) return;

        const newTool: AgentAsToolDefinition = {
            runtimeId: agent.agentRuntimeId,
            endpoint: "DEFAULT",
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

    const getAgentNameByRuntimeId = (runtimeId: string): string =>
        availableAgents.find((a) => isRuntime(a, runtimeId))?.agentName || runtimeId;

    // -------------------------------------------------------------------
    // Tool management for the orchestrator
    // -------------------------------------------------------------------
    const {
        addTool: addOrchestratorTool,
        removeTool: removeOrchestratorTool,
        addKnowledgeBase: addOrchestratorKnowledgeBase,
        addMcpServer: addOrchestratorMcpServer,
        removeMcpServer: removeOrchestratorMcpServer,
    } = toolSelectionActions(agentsAsToolsConfig, setAgentsAsToolsConfig);

    // Derive filtered options
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

    const hasCustomTools = availableToolsOptions.length > 0;
    const hasMcpServers = availableMcpServersOptions.length > 0;

    const selectedToolsData = orchestratorTools
        .filter((t) => !t.startsWith("retrieve_from_kb_"))
        .map((t) => ({ name: t }));

    const selectedKnowledgeBasesData = orchestratorTools
        .filter((t) => t.startsWith("retrieve_from_kb_"))
        .map((toolName) => {
            const kbId = toolName.replace("retrieve_from_kb_", "");
            const kb = availableKnowledgeBases.find((k) => k.value === kbId);
            return { toolName, name: kb?.label || kbId };
        });

    // Build the serialization preview
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
                        <AgentNameField
                            value={config.agentName}
                            onChange={(agentName) => setConfig((prev) => ({ ...prev, agentName }))}
                            description="Enter a unique name for your agents-as-tools orchestrator"
                            maxLength={AGENT_NAME_MAX_LENGTH}
                        />

                        <Container
                            header={
                                <Header
                                    variant="h2"
                                    description="Select existing agents to expose as tools to the orchestrator. Each sub-agent's capability description (set on the sub-agent itself) is what the orchestrator's LLM reads when deciding whether to delegate."
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
                                                    !agentsAsToolsConfig.agentsAsTools.some((t) =>
                                                        isRuntime(a, t.runtimeId),
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
                                        loading={agentsLoading}
                                        loadingText="Loading agents"
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
                                                    const agent = availableAgents.find((a) =>
                                                        isRuntime(a, item.runtimeId),
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
                                                        availableAgents.find(
                                                            (a) => a.agentName === agentName,
                                                        ),
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
                        <AgentConfigSection
                            label="Orchestrator"
                            modelOptions={modelOptions}
                            {...bindModelParams(
                                agentsAsToolsConfig.modelInferenceParameters,
                                setAgentsAsToolsConfig,
                            )}
                            instructions={agentsAsToolsConfig.instructions}
                            onInstructionsChange={(instructions) =>
                                setAgentsAsToolsConfig((prev) => ({ ...prev, instructions }))
                            }
                            instructionsPlaceholder="You are an orchestrator agent. You have access to the following sub-agents as tools..."
                            conversationManager={agentsAsToolsConfig.conversationManager}
                            onConversationManagerChange={(conversationManager) =>
                                setAgentsAsToolsConfig((prev) => ({
                                    ...prev,
                                    conversationManager,
                                }))
                            }
                            useMemory={config.useMemory || false}
                            onUseMemoryChange={(useMemory) =>
                                setConfig((prev) => ({ ...prev, useMemory }))
                            }
                        />

                        {(hasCustomTools || hasMcpServers || knowledgeBaseIsSupported) && (
                            <AdditionalToolsSection
                                hasCustomTools={hasCustomTools}
                                hasMcpServers={hasMcpServers}
                                knowledgeBaseIsSupported={knowledgeBaseIsSupported}
                                availableToolsOptions={filteredToolOptions}
                                availableKnowledgeBasesOptions={filteredKbOptions}
                                availableMcpServersOptions={filteredMcpOptions}
                                selectedTools={selectedToolsData}
                                selectedKnowledgeBases={selectedKnowledgeBasesData}
                                selectedMcpServers={orchestratorMcpServers.map((s) => ({
                                    name: s,
                                }))}
                                onAddTool={addOrchestratorTool}
                                onRemoveTool={removeOrchestratorTool}
                                onAddKnowledgeBase={addOrchestratorKnowledgeBase}
                                onAddMcpServer={addOrchestratorMcpServer}
                                onRemoveMcpServer={removeOrchestratorMcpServer}
                                description="Optionally add tools, knowledge bases, and MCP servers available to the orchestrator (in addition to the sub-agent tools)"
                                emptyMessage="No additional tools or MCP servers configured. The orchestrator will only use the sub-agent tools defined in the previous step."
                            />
                        )}
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 3: Review
        {
            title: "Review",
            content: (
                <ReviewStep
                    // Flatten to the shape AgentConfigView's guard expects (agentsAsTools,
                    // modelInferenceParameters and instructions at the top level).
                    config={
                        {
                            agentName: config.agentName,
                            useMemory: config.useMemory,
                            architectureType: "AGENTS_AS_TOOLS",
                            ...buildPreviewConfig(),
                        } as unknown as AgentCoreRuntimeConfiguration
                    }
                    // Raw JSON mirrors the saved (nested) submission shape.
                    rawForJson={{
                        agentName: config.agentName,
                        ...(config.useMemory ? { useMemory: true } : {}),
                        architectureType: "AGENTS_AS_TOOLS",
                        agentsAsToolsConfig: buildPreviewConfig(),
                    }}
                    agents={availableAgents}
                    summary="Review your agents-as-tools configuration before creating."
                    isCreating={isCreating}
                />
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
    // Step 0: Agents as Tools
    if (stepIndex === 0) {
        const hasAgentName = agentNameError(config.agentName, AGENT_NAME_MAX_LENGTH) === "";
        const hasAgentsAsTools = agentsAsToolsConfig.agentsAsTools.length > 0;
        return hasAgentName && hasAgentsAsTools;
    }

    // Step 1: Orchestrator Configuration
    if (stepIndex === 1) {
        const hasModel = agentsAsToolsConfig.modelInferenceParameters.modelId.trim() !== "";
        const hasInstructions = agentsAsToolsConfig.instructions.trim() !== "";
        if (!hasModel || !hasInstructions) return false;

        // Validate the reasoning budget per model — see isSingleAgentStepValid.
        const budget = agentsAsToolsConfig.modelInferenceParameters.reasoningBudget;
        if (budget != null) {
            return isReasoningEffortAccepted(
                agentsAsToolsConfig.modelInferenceParameters.modelId,
                budget,
            );
        }
        return true;
    }

    // Step 2: Review — always valid
    return true;
}
