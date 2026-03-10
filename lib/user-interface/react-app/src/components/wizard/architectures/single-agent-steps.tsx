// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    Container,
    FormField,
    Header,
    Input,
    SpaceBetween,
} from "@cloudscape-design/components";
import { KnowledgeBase, McpServer, Tool } from "../../../API";
import { AgentCoreRuntimeConfiguration } from "../types";
import { AdditionalToolsSection, AgentConfigSection } from "../wizard-shared-components";
import { STEP_MIN_HEIGHT, getReasoningType } from "../wizard-utils";

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
    const hasCustomTools = availableTools.filter((t) => !t.invokesSubAgent).length > 0;
    const hasMcpServers = availableMcpServers.length > 0;

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
        .map((toolName) => ({ name: toolName }));

    const selectedKnowledgeBasesData = config.tools
        .filter((t) => t.startsWith("retrieve_from_kb_"))
        .map((toolName) => {
            const kbId = toolName.replace("retrieve_from_kb_", "");
            const kb = knowledgeBases.find((k) => k.id === kbId);
            return { toolName, name: kb?.name || kbId };
        });

    // -------------------------------------------------------------------
    // Steps
    // -------------------------------------------------------------------
    const hasToolsStep = hasCustomTools || hasMcpServers || knowledgeBaseIsSupported;

    const steps = [
        // Step 1: Agent Configuration
        {
            title: "Agent Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <Container header={<Header variant="h2">Agent Name</Header>}>
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

                        <AgentConfigSection
                            label="Agent"
                            modelOptions={modelOptions}
                            modelId={config.modelInferenceParameters.modelId}
                            onModelChange={(modelId) =>
                                setConfig((prev) => {
                                    const newReasoningType = getReasoningType(modelId);
                                    const oldReasoningType = getReasoningType(
                                        prev.modelInferenceParameters.modelId,
                                    );
                                    // Clear reasoning budget if model type changed
                                    const keepBudget =
                                        newReasoningType !== null &&
                                        newReasoningType === oldReasoningType;
                                    return {
                                        ...prev,
                                        modelInferenceParameters: {
                                            ...prev.modelInferenceParameters,
                                            modelId,
                                            ...(keepBudget ? {} : { reasoningBudget: undefined }),
                                        },
                                    };
                                })
                            }
                            temperature={config.modelInferenceParameters.parameters.temperature}
                            onTemperatureChange={(temperature) =>
                                setConfig((prev) => ({
                                    ...prev,
                                    modelInferenceParameters: {
                                        ...prev.modelInferenceParameters,
                                        parameters: {
                                            ...prev.modelInferenceParameters.parameters,
                                            temperature,
                                        },
                                    },
                                }))
                            }
                            maxTokens={config.modelInferenceParameters.parameters.maxTokens}
                            onMaxTokensChange={(maxTokens) =>
                                setConfig((prev) => ({
                                    ...prev,
                                    modelInferenceParameters: {
                                        ...prev.modelInferenceParameters,
                                        parameters: {
                                            ...prev.modelInferenceParameters.parameters,
                                            maxTokens,
                                        },
                                    },
                                }))
                            }
                            instructions={config.instructions}
                            onInstructionsChange={(instructions) =>
                                setConfig((prev) => ({ ...prev, instructions }))
                            }
                            conversationManager={config.conversationManager}
                            onConversationManagerChange={(conversationManager) =>
                                setConfig((prev) => ({ ...prev, conversationManager }))
                            }
                            useMemory={config.useMemory || false}
                            onUseMemoryChange={(useMemory) =>
                                setConfig((prev) => ({ ...prev, useMemory }))
                            }
                            reasoningBudget={config.modelInferenceParameters.reasoningBudget}
                            onReasoningBudgetChange={(reasoningBudget) =>
                                setConfig((prev) => ({
                                    ...prev,
                                    modelInferenceParameters: {
                                        ...prev.modelInferenceParameters,
                                        reasoningBudget,
                                    },
                                }))
                            }
                        />
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 2: Review (Tools step is conditionally inserted below)
        {
            title: "Review",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        {!isCreating && (
                            <Alert type="info" header="Configuration Summary">
                                Review your agent configuration before creating.
                            </Alert>
                        )}
                        <Container header={<Header variant="h2">Configuration JSON</Header>}>
                            <Box padding="m" variant="code">
                                <pre
                                    style={{
                                        margin: 0,
                                        overflow: "auto",
                                        maxHeight: "400px",
                                    }}
                                >
                                    {JSON.stringify(config, null, 2)}
                                </pre>
                            </Box>
                        </Container>
                    </SpaceBetween>
                </div>
            ),
        },
    ];

    // Conditionally insert the Tools step before Review
    if (hasToolsStep) {
        steps.splice(steps.length - 1, 0, {
            title: "Tools",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <AdditionalToolsSection
                        title="Tools"
                        description="Add tools, knowledge bases, and MCP servers to extend your agent's capabilities"
                        hasCustomTools={hasCustomTools}
                        hasMcpServers={hasMcpServers}
                        knowledgeBaseIsSupported={knowledgeBaseIsSupported}
                        availableToolsOptions={availableToolsOptions}
                        availableKnowledgeBasesOptions={availableKnowledgeBasesOptions}
                        availableMcpServersOptions={availableMcpServersOptions}
                        selectedTools={selectedToolsData}
                        selectedKnowledgeBases={selectedKnowledgeBasesData}
                        selectedMcpServers={config.mcpServers.map((s) => ({ name: s }))}
                        onAddTool={addTool}
                        onRemoveTool={removeTool}
                        onAddKnowledgeBase={addKnowledgeBase}
                        onAddMcpServer={addMcpServer}
                        onRemoveMcpServer={removeMcpServer}
                        onConfigureKnowledgeBase={openConfigureModal}
                    />
                </div>
            ),
        });
    }

    return steps;
}

/** Validate a single-agent step */
export function isSingleAgentStepValid(
    stepIndex: number,
    config: AgentCoreRuntimeConfiguration,
): boolean {
    // Step 0: Agent Configuration
    if (stepIndex === 0) {
        const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
        const basicValid =
            config.agentName.trim() !== "" &&
            agentNamePattern.test(config.agentName) &&
            config.instructions.trim() !== "" &&
            config.modelInferenceParameters.modelId.trim() !== "";
        if (!basicValid) return false;

        // Validate reasoning budget if enabled
        const budget = config.modelInferenceParameters.reasoningBudget;
        if (budget !== undefined) {
            const rType = getReasoningType(config.modelInferenceParameters.modelId);
            if (rType === "int") {
                return typeof budget === "number" && budget >= 1024;
            }
            if (rType === "effort") {
                return typeof budget === "string" && ["low", "medium", "high"].includes(budget);
            }
            // Model doesn't support reasoning but budget is set — invalid
            return false;
        }
        return true;
    }
    // Step 1: Additional Tools — always valid (optional)
    // Step 2: Review — always valid
    return true;
}
