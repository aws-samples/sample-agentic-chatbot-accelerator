// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { useEffect, useState } from "react";

import {
    Alert,
    Box,
    Button,
    Checkbox,
    ColumnLayout,
    Container,
    FormField,
    Header,
    Input,
    Select,
    SpaceBetween,
    Textarea,
    TokenGroup,
} from "@cloudscape-design/components";
import { KnowledgeBase, McpServer, Tool } from "../../../API";
import { listSkills as listSkillsQuery } from "../../../graphql/queries";
import { AgentCoreRuntimeConfiguration } from "../types";
import {
    AdditionalToolsSection,
    AgentConfigSection,
    AgentNameField,
} from "../wizard-shared-components";
import {
    bindModelParams,
    toolSelectionActions,
    PYTHON_TYPE_OPTIONS,
    STEP_MIN_HEIGHT,
    isReasoningEffortAccepted,
    SINGLE_AGENT_NAME_MAX_LENGTH,
    agentNameError,
} from "../wizard-utils";
import ReviewStep from "./review-step";
import { apiClient } from "../../../common/api-client";

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
    const { addTool, removeTool, addMcpServer, removeMcpServer, addKnowledgeBase } =
        toolSelectionActions(config, setConfig);

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
                        <AgentNameField
                            value={config.agentName}
                            onChange={(agentName) => setConfig((prev) => ({ ...prev, agentName }))}
                            description="Enter a unique name for your agent"
                            maxLength={SINGLE_AGENT_NAME_MAX_LENGTH}
                        />

                        <AgentConfigSection
                            label="Agent"
                            modelOptions={modelOptions}
                            {...bindModelParams(config.modelInferenceParameters, setConfig)}
                            instructions={config.instructions}
                            onInstructionsChange={(instructions) =>
                                setConfig((prev) => ({ ...prev, instructions }))
                            }
                            description={config.description}
                            onDescriptionChange={(description) =>
                                setConfig((prev) => ({ ...prev, description }))
                            }
                            conversationManager={config.conversationManager}
                            onConversationManagerChange={(conversationManager) =>
                                setConfig((prev) => ({ ...prev, conversationManager }))
                            }
                            useMemory={config.useMemory || false}
                            onUseMemoryChange={(useMemory) =>
                                setConfig((prev) => ({ ...prev, useMemory }))
                            }
                        />

                        {/* ── Structured Output ────────────────────────────── */}
                        <Container
                            header={
                                <Header
                                    variant="h2"
                                    description="When enabled, the agent's final response will be parsed into a structured JSON object with the fields you define below."
                                >
                                    Structured Output
                                </Header>
                            }
                        >
                            <SpaceBetween direction="vertical" size="m">
                                <Checkbox
                                    checked={Array.isArray(config.structuredOutput)}
                                    onChange={({ detail }) =>
                                        setConfig((prev) => ({
                                            ...prev,
                                            structuredOutput: detail.checked ? [] : undefined,
                                        }))
                                    }
                                >
                                    Enable Structured Output
                                </Checkbox>

                                {Array.isArray(config.structuredOutput) && (
                                    <>
                                        {config.structuredOutput.length === 0 && (
                                            <Box
                                                textAlign="center"
                                                color="text-body-secondary"
                                                padding="l"
                                            >
                                                No fields defined yet. Click &quot;Add Field&quot;
                                                to start.
                                            </Box>
                                        )}

                                        {config.structuredOutput.map((field, idx) => (
                                            <Container
                                                key={idx}
                                                header={
                                                    <Header
                                                        variant="h3"
                                                        actions={
                                                            <Button
                                                                variant="icon"
                                                                iconName="close"
                                                                onClick={() =>
                                                                    setConfig((prev) => ({
                                                                        ...prev,
                                                                        structuredOutput: (
                                                                            prev.structuredOutput ||
                                                                            []
                                                                        ).filter(
                                                                            (_, i) => i !== idx,
                                                                        ),
                                                                    }))
                                                                }
                                                            />
                                                        }
                                                    >
                                                        Field {idx + 1}
                                                    </Header>
                                                }
                                            >
                                                <SpaceBetween direction="vertical" size="s">
                                                    <ColumnLayout columns={2} variant="text-grid">
                                                        <FormField label="Field Name">
                                                            <Input
                                                                value={field.name}
                                                                placeholder="e.g. loop_id"
                                                                onChange={({ detail }) => {
                                                                    setConfig((prev) => {
                                                                        const fields = [
                                                                            ...(prev.structuredOutput ||
                                                                                []),
                                                                        ];
                                                                        fields[idx] = {
                                                                            ...fields[idx],
                                                                            name: detail.value,
                                                                        };
                                                                        return {
                                                                            ...prev,
                                                                            structuredOutput:
                                                                                fields,
                                                                        };
                                                                    });
                                                                }}
                                                            />
                                                        </FormField>
                                                        <FormField label="Python Type">
                                                            <Select
                                                                selectedOption={
                                                                    PYTHON_TYPE_OPTIONS.find(
                                                                        (o) =>
                                                                            o.value ===
                                                                            field.pythonType,
                                                                    ) || null
                                                                }
                                                                options={PYTHON_TYPE_OPTIONS}
                                                                onChange={({ detail }) => {
                                                                    setConfig((prev) => {
                                                                        const fields = [
                                                                            ...(prev.structuredOutput ||
                                                                                []),
                                                                        ];
                                                                        fields[idx] = {
                                                                            ...fields[idx],
                                                                            pythonType:
                                                                                detail
                                                                                    .selectedOption
                                                                                    ?.value ||
                                                                                "str",
                                                                        };
                                                                        return {
                                                                            ...prev,
                                                                            structuredOutput:
                                                                                fields,
                                                                        };
                                                                    });
                                                                }}
                                                                placeholder="Select type..."
                                                            />
                                                        </FormField>
                                                    </ColumnLayout>
                                                    <FormField label="Description">
                                                        <Textarea
                                                            value={field.description}
                                                            placeholder="Describe this field..."
                                                            rows={2}
                                                            onChange={({ detail }) => {
                                                                setConfig((prev) => {
                                                                    const fields = [
                                                                        ...(prev.structuredOutput ||
                                                                            []),
                                                                    ];
                                                                    fields[idx] = {
                                                                        ...fields[idx],
                                                                        description: detail.value,
                                                                    };
                                                                    return {
                                                                        ...prev,
                                                                        structuredOutput: fields,
                                                                    };
                                                                });
                                                            }}
                                                        />
                                                    </FormField>
                                                    <Checkbox
                                                        checked={field.optional}
                                                        onChange={({ detail }) => {
                                                            setConfig((prev) => {
                                                                const fields = [
                                                                    ...(prev.structuredOutput ||
                                                                        []),
                                                                ];
                                                                fields[idx] = {
                                                                    ...fields[idx],
                                                                    optional: detail.checked,
                                                                };
                                                                return {
                                                                    ...prev,
                                                                    structuredOutput: fields,
                                                                };
                                                            });
                                                        }}
                                                    >
                                                        Optional (defaults to None when not
                                                        provided)
                                                    </Checkbox>
                                                </SpaceBetween>
                                            </Container>
                                        ))}

                                        <Button
                                            iconName="add-plus"
                                            onClick={() => {
                                                setConfig((prev) => ({
                                                    ...prev,
                                                    structuredOutput: [
                                                        ...(prev.structuredOutput || []),
                                                        {
                                                            name: "",
                                                            pythonType: "str",
                                                            description: "",
                                                            optional: false,
                                                        },
                                                    ],
                                                }));
                                            }}
                                        >
                                            Add Field
                                        </Button>

                                        {config.structuredOutput.length > 0 &&
                                            config.structuredOutput.some(
                                                (f) => !f.name.trim() || !f.description.trim(),
                                            ) && (
                                                <Alert type="warning">
                                                    All structured output fields must have a
                                                    non-empty name and description.
                                                </Alert>
                                            )}
                                    </>
                                )}
                            </SpaceBetween>
                        </Container>
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 2: Review (Tools step is conditionally inserted below)
        {
            title: "Review",
            content: (
                <ReviewStep
                    config={config}
                    summary="Review your agent configuration before creating."
                    isCreating={isCreating}
                />
            ),
        },
    ];

    // Conditionally insert the Tools & Skills step before Review
    if (hasToolsStep) {
        steps.splice(steps.length - 1, 0, {
            title: "Tools & Skills",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
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

                        {/* ── Skills ────────────────────────────────────── */}
                        <SkillsSection config={config} setConfig={setConfig} />
                    </SpaceBetween>
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
        const basicValid =
            agentNameError(config.agentName, SINGLE_AGENT_NAME_MAX_LENGTH) === "" &&
            config.instructions.trim() !== "" &&
            config.modelInferenceParameters.modelId.trim() !== "";
        if (!basicValid) return false;

        // Validate the reasoning budget per model: a value the selected model
        // does not accept is rejected by the backend at config-parse time.
        const budget = config.modelInferenceParameters.reasoningBudget;
        if (
            budget != null &&
            !isReasoningEffortAccepted(config.modelInferenceParameters.modelId, budget)
        ) {
            return false;
        }

        // Validate structured output if enabled
        if (Array.isArray(config.structuredOutput)) {
            // Must have at least one field
            if (config.structuredOutput.length === 0) return false;
            // Every field must have a non-empty name and description
            const allFieldsValid = config.structuredOutput.every(
                (f) =>
                    f.name.trim() !== "" &&
                    f.pythonType.trim() !== "" &&
                    f.description.trim() !== "",
            );
            if (!allFieldsValid) return false;
            // Field names must be valid Python identifiers (letters, digits, underscores, starting with letter/underscore)
            const pyIdentPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
            const allNamesValid = config.structuredOutput.every((f) =>
                pyIdentPattern.test(f.name.trim()),
            );
            if (!allNamesValid) return false;
            // Field names must be unique
            const names = config.structuredOutput.map((f) => f.name.trim());
            if (new Set(names).size !== names.length) return false;
        }

        return true;
    }
    // Step 1: Additional Tools — always valid (optional)
    // Step 2: Review — always valid
    return true;
}

// ── Skills attachment section ──────────────────────────────────────
// Self-contained component that fetches available skills and lets
// the user attach/detach them from the agent configuration.

function SkillsSection({
    config,
    setConfig,
}: {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
}) {
    const [availableSkills, setAvailableSkills] = useState<{ name: string; description: string }[]>(
        [],
    );
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchSkills = async () => {
            setLoading(true);
            try {
                const result = await apiClient.graphql({ query: listSkillsQuery });
                setAvailableSkills(
                    ((result.data as any)?.listSkills || []).map((s: any) => ({
                        name: s.name,
                        description: s.description || "",
                    })),
                );
            } catch (err) {
                console.error("Failed to fetch skills:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchSkills();
    }, []);

    const attachedSkills = config.skills || [];

    const unattachedOptions = availableSkills
        .filter((s) => !attachedSkills.includes(s.name))
        .map((s) => ({
            label: s.name,
            value: s.name,
            description: s.description,
        }));

    const addSkill = (name: string | undefined) => {
        if (!name || attachedSkills.includes(name)) return;
        setConfig((prev) => ({ ...prev, skills: [...(prev.skills || []), name] }));
    };

    const removeSkill = (name: string) => {
        setConfig((prev) => ({
            ...prev,
            skills: (prev.skills || []).filter((s) => s !== name),
        }));
    };

    return (
        <Container
            header={
                <Header
                    variant="h2"
                    description="Attach skills to give the agent on-demand access to specialized instructions. Skills are loaded only when the agent activates them."
                >
                    Skills
                </Header>
            }
        >
            <SpaceBetween direction="vertical" size="m">
                <FormField label="Add a skill">
                    <Select
                        placeholder={loading ? "Loading skills..." : "Select a skill to attach..."}
                        options={unattachedOptions}
                        onChange={({ detail }) => addSkill(detail.selectedOption?.value)}
                        selectedOption={null}
                        disabled={loading || unattachedOptions.length === 0}
                        filteringType="auto"
                    />
                </FormField>

                {attachedSkills.length > 0 ? (
                    <TokenGroup
                        items={attachedSkills.map((name) => {
                            const skill = availableSkills.find((s) => s.name === name);
                            return {
                                label: name,
                                description: skill?.description,
                                dismissLabel: `Remove ${name}`,
                            };
                        })}
                        onDismiss={({ detail }) => {
                            removeSkill(attachedSkills[detail.itemIndex]);
                        }}
                    />
                ) : (
                    <Box textAlign="center" color="text-body-secondary" padding="s">
                        No skills attached. The agent will work without specialized instructions.
                    </Box>
                )}
            </SpaceBetween>
        </Container>
    );
}
