// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Button,
    Checkbox,
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
import {
    CONVERSATION_MANAGER_OPTIONS,
    REASONING_EFFORT_OPTIONS,
    getReasoningType,
} from "./wizard-utils";

// -------------------------------------------------------------------
// AgentConfigSection — Model, Instructions, Conversation Manager, Memory
// -------------------------------------------------------------------

export interface AgentConfigSectionProps {
    /** Label variant, e.g. "Agent" or "Orchestrator" */
    label?: string;
    modelOptions: { label: string; value: string }[];
    modelId: string;
    onModelChange: (modelId: string) => void;
    temperature: number;
    onTemperatureChange: (value: number) => void;
    maxTokens: number;
    onMaxTokensChange: (value: number) => void;
    instructions: string;
    onInstructionsChange: (value: string) => void;
    instructionsPlaceholder?: string;
    conversationManager: "null" | "sliding_window" | "summarizing";
    onConversationManagerChange: (value: "null" | "sliding_window" | "summarizing") => void;
    useMemory: boolean;
    onUseMemoryChange: (checked: boolean) => void;
    /** Optional reasoning budget — integer (tokens) or string ("low"/"medium"/"high") */
    reasoningBudget?: number | string;
    /** Callback when reasoning budget changes; undefined means disabled */
    onReasoningBudgetChange?: (value: number | string | undefined) => void;
}

export function AgentConfigSection({
    label = "Agent",
    modelOptions,
    modelId,
    onModelChange,
    temperature,
    onTemperatureChange,
    maxTokens,
    onMaxTokensChange,
    instructions,
    onInstructionsChange,
    instructionsPlaceholder,
    conversationManager,
    onConversationManagerChange,
    useMemory,
    onUseMemoryChange,
    reasoningBudget,
    onReasoningBudgetChange,
}: AgentConfigSectionProps) {
    const reasoningType = getReasoningType(modelId);
    const reasoningEnabled = reasoningBudget != null;

    return (
        <SpaceBetween direction="vertical" size="l">
            <Container header={<Header variant="h2">Model &amp; Instructions</Header>}>
                <SpaceBetween direction="vertical" size="l">
                    <ColumnLayout columns={2} variant="text-grid">
                        <SpaceBetween direction="vertical" size="s">
                            <FormField
                                label="Model"
                                description={`Select the LLM model for the ${label.toLowerCase()}`}
                            >
                                <Select
                                    placeholder="Select a model..."
                                    options={modelOptions}
                                    selectedOption={
                                        modelOptions.find((opt) => opt.value === modelId) || null
                                    }
                                    onChange={({ detail }) =>
                                        onModelChange(detail.selectedOption?.value || "")
                                    }
                                    filteringType="auto"
                                />
                            </FormField>

                            {reasoningType && onReasoningBudgetChange && (
                                <>
                                    <Checkbox
                                        checked={reasoningEnabled}
                                        onChange={({ detail }) => {
                                            if (detail.checked) {
                                                onReasoningBudgetChange(
                                                    reasoningType === "int" ? 1024 : "medium",
                                                );
                                            } else {
                                                onReasoningBudgetChange(undefined);
                                            }
                                        }}
                                    >
                                        Enable extended thinking
                                    </Checkbox>

                                    {reasoningEnabled && reasoningType === "int" && (
                                        <FormField
                                            label="Reasoning Budget (tokens)"
                                            description="Minimum 1024 tokens"
                                            errorText={
                                                typeof reasoningBudget === "number" &&
                                                reasoningBudget < 1024
                                                    ? "Budget must be at least 1024 tokens"
                                                    : ""
                                            }
                                        >
                                            <Input
                                                type="number"
                                                value={
                                                    reasoningBudget != null
                                                        ? reasoningBudget.toString()
                                                        : ""
                                                }
                                                onChange={({ detail }) => {
                                                    const val = parseInt(detail.value);
                                                    if (!isNaN(val)) {
                                                        onReasoningBudgetChange(val);
                                                    }
                                                }}
                                                step={256}
                                            />
                                        </FormField>
                                    )}

                                    {reasoningEnabled && reasoningType === "effort" && (
                                        <FormField
                                            label="Reasoning Effort"
                                            description="Select the reasoning effort level"
                                        >
                                            <Select
                                                selectedOption={
                                                    REASONING_EFFORT_OPTIONS.find(
                                                        (opt) => opt.value === reasoningBudget,
                                                    ) || null
                                                }
                                                onChange={({ detail }) =>
                                                    onReasoningBudgetChange(
                                                        detail.selectedOption?.value || "medium",
                                                    )
                                                }
                                                options={REASONING_EFFORT_OPTIONS}
                                            />
                                        </FormField>
                                    )}
                                </>
                            )}
                        </SpaceBetween>
                        <SpaceBetween direction="vertical" size="s">
                            <FormField label="Temperature" description="Controls randomness (0-1)">
                                <Input
                                    type="number"
                                    value={temperature.toString()}
                                    onChange={({ detail }) => {
                                        const value = parseFloat(detail.value) || 0;
                                        if (value >= 0 && value <= 1) {
                                            onTemperatureChange(value);
                                        }
                                    }}
                                    step={0.05}
                                />
                            </FormField>
                            <FormField label="Max Tokens" description="Maximum output tokens">
                                <Input
                                    type="number"
                                    value={maxTokens.toString()}
                                    onChange={({ detail }) => {
                                        const value = parseInt(detail.value) || 100;
                                        if (value >= 100 && value <= 4000) {
                                            onMaxTokensChange(value);
                                        }
                                    }}
                                    step={100}
                                />
                            </FormField>
                        </SpaceBetween>
                    </ColumnLayout>

                    <FormField
                        label={`${label} Instructions`}
                        description={`System prompt that defines the ${label.toLowerCase()}'s behavior`}
                        errorText={instructions.trim() === "" ? "Instructions are required" : ""}
                    >
                        <Textarea
                            value={instructions}
                            onChange={({ detail }) => onInstructionsChange(detail.value)}
                            placeholder={
                                instructionsPlaceholder ||
                                `Enter ${label.toLowerCase()} instructions...`
                            }
                            rows={6}
                            invalid={instructions.trim() === ""}
                        />
                    </FormField>

                    <FormField label="Conversation Manager">
                        <Select
                            selectedOption={
                                CONVERSATION_MANAGER_OPTIONS.find(
                                    (opt) => opt.value === conversationManager,
                                ) || null
                            }
                            onChange={({ detail }) =>
                                onConversationManagerChange(
                                    (detail.selectedOption?.value || "sliding_window") as
                                        | "null"
                                        | "sliding_window"
                                        | "summarizing",
                                )
                            }
                            options={CONVERSATION_MANAGER_OPTIONS}
                        />
                    </FormField>
                </SpaceBetween>
            </Container>

            <Container header={<Header variant="h2">Memory</Header>}>
                <SpaceBetween direction="vertical" size="s">
                    <Checkbox
                        checked={useMemory}
                        onChange={({ detail }) => onUseMemoryChange(detail.checked)}
                    >
                        Enable AgentCore Memory
                    </Checkbox>
                    {useMemory ? (
                        <Alert type="info">
                            AgentCore Memory will be created and attached to your agent Runtime,
                            allowing it to persist conversation context across sessions — even when
                            the underlying container is recycled.
                        </Alert>
                    ) : (
                        <Alert type="warning">
                            Without AgentCore Memory, the agent will not remember previous messages
                            when a session is reopened or the container is recycled. Session
                            continuity requires Memory to be enabled.
                        </Alert>
                    )}
                </SpaceBetween>
            </Container>
        </SpaceBetween>
    );
}

// -------------------------------------------------------------------
// AdditionalToolsSection — Tools, Knowledge Bases, MCP Servers
// -------------------------------------------------------------------

export interface AdditionalToolsSectionProps {
    /** Whether custom tools are available per CDK config */
    hasCustomTools: boolean;
    /** Whether MCP servers are available per CDK config */
    hasMcpServers: boolean;
    /** Whether knowledge base is supported */
    knowledgeBaseIsSupported: boolean;
    /** Filtered tool options (not yet selected) */
    availableToolsOptions: { label: string; value: string; description?: string }[];
    /** Filtered KB options (not yet selected) */
    availableKnowledgeBasesOptions: { label: string; value: string }[];
    /** Filtered MCP server options (not yet selected) */
    availableMcpServersOptions: { label: string; value: string; description?: string }[];
    /** Currently selected tool names */
    selectedTools: { name: string }[];
    /** Currently selected knowledge bases */
    selectedKnowledgeBases: { toolName: string; name: string }[];
    /** Currently selected MCP server names */
    selectedMcpServers: { name: string }[];
    /** Callbacks */
    onAddTool: (toolName: string | undefined) => void;
    onRemoveTool: (toolName: string) => void;
    onAddKnowledgeBase: (kbId: string | undefined) => void;
    onAddMcpServer: (serverName: string | undefined) => void;
    onRemoveMcpServer: (serverName: string) => void;
    /** Optional: opens a configure modal for KB parameters */
    onConfigureKnowledgeBase?: (toolName: string) => void;
    /** Title for the section header */
    title?: string;
    /** Description for the section header */
    description?: string;
    /** Message when nothing is selected */
    emptyMessage?: string;
}

export function AdditionalToolsSection({
    hasCustomTools,
    hasMcpServers,
    knowledgeBaseIsSupported,
    availableToolsOptions,
    availableKnowledgeBasesOptions,
    availableMcpServersOptions,
    selectedTools,
    selectedKnowledgeBases,
    selectedMcpServers,
    onAddTool,
    onRemoveTool,
    onAddKnowledgeBase,
    onAddMcpServer,
    onRemoveMcpServer,
    onConfigureKnowledgeBase,
    title = "Additional Tools (Optional)",
    description = "Optionally add tools, knowledge bases, and MCP servers to extend capabilities. Use 'Manage MCPs' on the AgentCore Manager page to register or delete MCP servers.",
    emptyMessage = "No tools configured yet. Use the dropdowns above to add tools, knowledge bases, or MCP servers.",
}: AdditionalToolsSectionProps) {
    const columnCount = [hasCustomTools, knowledgeBaseIsSupported, hasMcpServers].filter(
        Boolean,
    ).length;

    return (
        <Container
            header={
                <Header variant="h2" description={description}>
                    {title}
                </Header>
            }
        >
            <SpaceBetween direction="vertical" size="m">
                <ColumnLayout columns={columnCount || 1}>
                    {hasCustomTools && (
                        <FormField label="Add Tool">
                            <Select
                                placeholder="Select a tool..."
                                options={availableToolsOptions}
                                onChange={({ detail }) => onAddTool(detail.selectedOption?.value)}
                                selectedOption={null}
                                filteringType="auto"
                            />
                        </FormField>
                    )}
                    {knowledgeBaseIsSupported && (
                        <FormField label="Add Knowledge Base">
                            <Select
                                placeholder="Select a KB..."
                                options={availableKnowledgeBasesOptions}
                                onChange={({ detail }) =>
                                    onAddKnowledgeBase(detail.selectedOption?.value)
                                }
                                selectedOption={null}
                                filteringType="auto"
                            />
                        </FormField>
                    )}
                    {hasMcpServers && (
                        <FormField label="Add MCP Server">
                            <Select
                                placeholder="Select MCP server..."
                                options={availableMcpServersOptions}
                                onChange={({ detail }) =>
                                    onAddMcpServer(detail.selectedOption?.value)
                                }
                                selectedOption={null}
                                filteringType="auto"
                            />
                        </FormField>
                    )}
                </ColumnLayout>

                {selectedTools.length > 0 && (
                    <Table
                        items={selectedTools}
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
                                        onClick={() => onRemoveTool(item.name)}
                                    />
                                ),
                            },
                        ]}
                    />
                )}

                {selectedKnowledgeBases.length > 0 && (
                    <Table
                        items={selectedKnowledgeBases}
                        columnDefinitions={[
                            {
                                id: "name",
                                header: "Knowledge Base",
                                cell: (item) => item.name,
                                isRowHeader: true,
                            },
                            ...(onConfigureKnowledgeBase
                                ? [
                                      {
                                          id: "configure",
                                          header: "Parameters",
                                          cell: (item: { toolName: string; name: string }) => (
                                              <Button
                                                  variant="normal"
                                                  onClick={() =>
                                                      onConfigureKnowledgeBase(item.toolName)
                                                  }
                                              >
                                                  Configure
                                              </Button>
                                          ),
                                      },
                                  ]
                                : []),
                            {
                                id: "actions",
                                header: "Actions",
                                cell: (item) => (
                                    <Button
                                        variant="icon"
                                        iconName="close"
                                        onClick={() => onRemoveTool(item.toolName)}
                                    />
                                ),
                            },
                        ]}
                    />
                )}

                {selectedMcpServers.length > 0 && (
                    <Table
                        items={selectedMcpServers}
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
                                        onClick={() => onRemoveMcpServer(item.name)}
                                        ariaLabel="Remove from agent"
                                    />
                                ),
                            },
                        ]}
                    />
                )}

                {selectedTools.length === 0 &&
                    selectedKnowledgeBases.length === 0 &&
                    selectedMcpServers.length === 0 && <Alert type="info">{emptyMessage}</Alert>}
            </SpaceBetween>
        </Container>
    );
}
