// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useMemo, useState } from "react";

import {
    Box,
    Button,
    Checkbox,
    Container,
    FormField,
    Header,
    Input,
    Modal,
    RadioGroup,
    Select,
    SpaceBetween,
    Textarea,
    Wizard,
} from "@cloudscape-design/components";
import { KnowledgeBase, McpServer, RuntimeSummary, Tool } from "../../API";
import { AppContext } from "../../common/app-context";
import {
    listAgentEndpoints as listAgentEndpointsQuery,
    listAvailableMcpServers as listAvailableMcpServersQuery,
    listAvailableTools as listAvailableToolsQuery,
    listKnowledgeBases as listKnowledgeBasesQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";
import { getSingleAgentSteps, isSingleAgentStepValid } from "./architectures/single-agent-steps";
import { getSwarmAgentSteps, isSwarmStepValid } from "./architectures/swarm-agent-steps";
import {
    AgentCoreRuntimeConfiguration,
    ArchitectureType,
    SearchType,
    SwarmConfiguration,
} from "./types";
import { DANGEROUS_KEYS, STEP_MIN_HEIGHT, safeDeepSet } from "./wizard-utils";

interface AgentCoreRuntimeCreatorWizardProps {
    onSubmit: (config: AgentCoreRuntimeConfiguration) => void;
    onCancel: () => void;
    initialData?: Partial<AgentCoreRuntimeConfiguration>;
    isCreating?: boolean;
    asPage?: boolean;
}

export default function AgentCoreRuntimeCreatorWizard({
    onSubmit,
    onCancel,
    initialData,
    isCreating = false,
    asPage = false,
}: AgentCoreRuntimeCreatorWizardProps) {
    const appConfig = useContext(AppContext);

    const [activeStepIndex, setActiveStepIndex] = useState(0);
    const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
    const [availableTools, setAvailableTools] = useState<Tool[]>([]);
    const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);
    const [availableAgents, setAvailableAgents] = useState<RuntimeSummary[]>([]);
    const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);
    const [rerankingModelOptions, setRerankingModelOptions] = useState<
        { label: string; value: string }[]
    >([]);
    const [configureModalVisible, setConfigureModalVisible] = useState(false);
    const [selectedKbForConfig, setSelectedKbForConfig] = useState<string | null>(null);
    const [selectedToolForConfig, setSelectedToolForConfig] = useState<string | null>(null);
    const [availableEndpoints, setAvailableEndpoints] = useState<string[]>([]);
    const [enableSearchType, setEnableSearchType] = useState<{ [key: string]: boolean }>({});
    const [enableReranking, setEnableReranking] = useState<{ [key: string]: boolean }>({});
    const [architectureType, setArchitectureType] = useState<ArchitectureType>(
        initialData?.architectureType || "SINGLE",
    );
    const [swarmConfig, setSwarmConfig] = useState<SwarmConfiguration>(
        initialData?.swarmConfig || {
            agents: [],
            agentReferences: [],
            entryAgent: "",
            orchestrator: {
                maxHandoffs: 15,
                maxIterations: 50,
                executionTimeoutSeconds: 300,
                nodeTimeoutSeconds: 60,
            },
            conversationManager: "sliding_window",
        },
    );

    // When creating a new version, skip the architecture selector step
    const isNewVersion = !!initialData?.architectureType;

    // Initialize enableReranking and enableSearchType from initialData on mount
    useEffect(() => {
        if (initialData?.toolParameters) {
            const rerankingStates: { [key: string]: boolean } = {};
            const searchTypeStates: { [key: string]: boolean } = {};

            Object.keys(initialData.toolParameters).forEach((toolName) => {
                if (toolName.startsWith("retrieve_from_kb_")) {
                    const toolParams = initialData.toolParameters![toolName];
                    if (
                        toolParams?.retrieval_cfg?.vectorSearchConfiguration
                            ?.rerankingConfiguration?.bedrockRerankingConfiguration?.numberOfResults
                    ) {
                        rerankingStates[toolName] = true;
                    }
                    if (
                        toolParams?.retrieval_cfg?.vectorSearchConfiguration?.overrideSearchType
                    ) {
                        searchTypeStates[toolName] = true;
                    }
                }
            });

            if (Object.keys(rerankingStates).length > 0) setEnableReranking(rerankingStates);
            if (Object.keys(searchTypeStates).length > 0) setEnableSearchType(searchTypeStates);
        }
    }, [initialData]);

    const [config, setConfig] = useState<AgentCoreRuntimeConfiguration>({
        agentName: initialData?.agentName || "",
        instructions: initialData?.instructions || "",
        tools: initialData?.tools || [],
        toolParameters: initialData?.toolParameters || {},
        mcpServers: initialData?.mcpServers || [],
        conversationManager: initialData?.conversationManager || "sliding_window",
        useMemory: initialData?.useMemory || false,
        modelInferenceParameters: initialData?.modelInferenceParameters || {
            modelId: "",
            parameters: { temperature: 0.2, maxTokens: 3000 },
        },
    });

    const apiClient = useMemo(() => generateClient(), []);

    // ----------------------------------------------------------------
    // Data fetching
    // ----------------------------------------------------------------
    useEffect(() => {
        if (!appConfig) return;
        let isCancelled = false;

        const fetchData = async () => {
            try {
                const knowledgeBaseSupported = appConfig?.knowledgeBaseIsSupported ?? false;
                const [kbResult, toolsResult, mcpServersResult, agentsResult] =
                    await Promise.all([
                        knowledgeBaseSupported
                            ? apiClient.graphql({ query: listKnowledgeBasesQuery })
                            : Promise.resolve({ data: { listKnowledgeBases: [] } }),
                        apiClient.graphql({ query: listAvailableToolsQuery }),
                        apiClient.graphql({ query: listAvailableMcpServersQuery }),
                        apiClient.graphql({ query: listRuntimeAgentsQuery }),
                    ]);

                if (isCancelled) return;
                setKnowledgeBases(kbResult.data!.listKnowledgeBases);
                if (toolsResult.data?.listAvailableTools)
                    setAvailableTools(toolsResult.data.listAvailableTools);
                if (mcpServersResult.data?.listAvailableMcpServers)
                    setAvailableMcpServers(mcpServersResult.data.listAvailableMcpServers);
                if (agentsResult.data?.listRuntimeAgents)
                    setAvailableAgents(agentsResult.data.listRuntimeAgents);
            } catch (error) {
                console.error("Failed to fetch data:", error);
            }
        };
        fetchData();
        return () => { isCancelled = true; };
    }, [appConfig, apiClient]);

    useEffect(() => {
        if (appConfig && appConfig.aws_bedrock_supported_models) {
            const models = Object.entries(appConfig.aws_bedrock_supported_models).map(
                ([label, value]) => ({
                    label,
                    value: value.replace("[REGION-PREFIX]", appConfig.aws_project_region.split("-")[0]),
                }),
            );
            setModelOptions(models);

            if (!config.modelInferenceParameters.modelId) {
                const defaultModel = models.find(
                    (m) =>
                        m.label.toLowerCase().includes("claude") &&
                        m.label.toLowerCase().includes("haiku") &&
                        m.label.toLowerCase().includes("4.5"),
                );
                if (defaultModel) {
                    setConfig((prev) => ({
                        ...prev,
                        modelInferenceParameters: {
                            ...prev.modelInferenceParameters,
                            modelId: defaultModel.value,
                        },
                    }));
                }
            }

            if (appConfig.aws_bedrock_supported_reranking_models) {
                setRerankingModelOptions(
                    Object.entries(appConfig.aws_bedrock_supported_reranking_models).map(
                        ([label, value]) => ({ label, value }),
                    ),
                );
            }
        }
    }, [appConfig, config.modelInferenceParameters.modelId]);

    // ----------------------------------------------------------------
    // Tool / KB / MCP / Sub-agent actions (used by single-agent steps)
    // ----------------------------------------------------------------
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

    const addSubAgent = (agentName: string | undefined) => {
        if (!agentName) return;
        const toolName = `invoke_subagent_${agentName}`;
        if (config.tools.includes(toolName)) return;
        setConfig((prev) => ({
            ...prev,
            tools: [...prev.tools, toolName],
            toolParameters: {
                ...prev.toolParameters,
                [toolName]: { agentName, qualifier: "DEFAULT", role: "" },
            },
        }));
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

    const updateToolParameter = (toolName: string, paramPath: string, value: any) => {
        setConfig((prev) => {
            if (DANGEROUS_KEYS.has(toolName)) {
                console.error("Invalid tool name detected - potential prototype pollution");
                return prev;
            }
            const currentToolParams = prev.toolParameters[toolName] || {};
            const updatedToolParams = safeDeepSet(currentToolParams, paramPath, value);
            if (updatedToolParams === currentToolParams) return prev;
            return {
                ...prev,
                toolParameters: { ...prev.toolParameters, [toolName]: updatedToolParams },
            };
        });
    };

    const openConfigureModal = async (toolName: string) => {
        if (toolName.startsWith("retrieve_from_kb_")) {
            setSelectedKbForConfig(toolName);
            const hasOverrideSearchType =
                config.toolParameters[toolName]?.retrieval_cfg?.vectorSearchConfiguration
                    ?.overrideSearchType;
            setEnableSearchType((prev) => ({ ...prev, [toolName]: !!hasOverrideSearchType }));
            const hasRerankingConfig =
                config.toolParameters[toolName]?.retrieval_cfg?.vectorSearchConfiguration
                    ?.rerankingConfiguration?.bedrockRerankingConfiguration?.numberOfResults;
            setEnableReranking((prev) => ({ ...prev, [toolName]: !!hasRerankingConfig }));
        } else {
            setSelectedToolForConfig(toolName);
            if (toolName.startsWith("invoke_subagent_")) {
                const agentName = toolName.replace("invoke_subagent_", "");
                const agent = availableAgents.find((a) => a.agentName === agentName);
                if (agent) {
                    try {
                        const endpointsResult = await apiClient.graphql({
                            query: listAgentEndpointsQuery,
                            variables: { agentRuntimeId: agent.agentRuntimeId },
                        });
                        setAvailableEndpoints(
                            (endpointsResult.data?.listAgentEndpoints || []).filter(
                                (endpoint): endpoint is string => endpoint !== null,
                            ),
                        );
                    } catch (error) {
                        console.error("Failed to fetch endpoints:", error);
                        setAvailableEndpoints([]);
                    }
                }
            }
        }
        setConfigureModalVisible(true);
    };

    const closeConfigureModal = () => {
        setConfigureModalVisible(false);
        setSelectedKbForConfig(null);
        setSelectedToolForConfig(null);
    };

    // ----------------------------------------------------------------
    // Swarm-specific actions
    // ----------------------------------------------------------------
    const addAgentReference = (agentName: string) => {
        if (swarmConfig.agentReferences.some((r) => r.agentName === agentName)) return;
        setSwarmConfig((prev) => ({
            ...prev,
            agentReferences: [...prev.agentReferences, { agentName, endpointName: "DEFAULT" }],
        }));
    };

    const removeAgentReference = (index: number) => {
        setSwarmConfig((prev) => {
            const removedName = prev.agentReferences[index].agentName;
            return {
                ...prev,
                agentReferences: prev.agentReferences.filter((_, i) => i !== index),
                entryAgent: prev.entryAgent === removedName ? "" : prev.entryAgent,
            };
        });
    };

    const updateAgentReferenceEndpoint = (index: number, endpointName: string) => {
        setSwarmConfig((prev) => {
            const newRefs = [...prev.agentReferences];
            newRefs[index] = { ...newRefs[index], endpointName };
            return { ...prev, agentReferences: newRefs };
        });
    };

    const getSwarmAgentNames = (): string[] => {
        return swarmConfig.agentReferences.map((r) => r.agentName);
    };

    // ----------------------------------------------------------------
    // Derived data for single-agent steps
    // ----------------------------------------------------------------
    const knowledgeBaseIsSupported = appConfig?.knowledgeBaseIsSupported ?? false;

    const availableKnowledgeBases = knowledgeBases
        .filter((kb) => !config.tools.some((tool) => tool === `retrieve_from_kb_${kb.id}`))
        .map((kb) => ({ label: kb.description || kb.name, value: kb.id }));

    const availableToolsOptions = availableTools
        .filter((tool) => !tool.invokesSubAgent && !config.tools.includes(tool.name))
        .map((tool) => ({ label: tool.name, value: tool.name, description: tool.description || undefined }));

    const availableSubAgents = availableAgents
        .filter(
            (agent) =>
                agent.agentName !== config.agentName &&
                !config.tools.includes(`invoke_subagent_${agent.agentName}`),
        )
        .map((agent) => ({ label: agent.agentName, value: agent.agentName }));

    const availableMcpServersOptions = availableMcpServers
        .filter((s) => !config.mcpServers.includes(s.name))
        .map((s) => ({ label: s.name, value: s.name, description: s.description || undefined }));

    const selectedMcpServersData = config.mcpServers.map((serverName) => {
        const serverInfo = availableMcpServers.find((s) => s.name === serverName);
        return {
            name: serverName,
            description: serverInfo?.description || "No description available",
            mcpUrl: serverInfo?.mcpUrl || "",
        };
    });

    const selectedToolsData = config.tools
        .filter((t) => !t.startsWith("retrieve_from_kb_") && !t.startsWith("invoke_subagent_"))
        .map((toolName) => {
            const toolInfo = availableTools.find((t) => t.name === toolName);
            return { name: toolName, description: toolInfo?.description || "No description available" };
        });

    const selectedSubAgentsData = config.tools
        .filter((t) => t.startsWith("invoke_subagent_"))
        .map((toolName) => ({
            toolName,
            agentName: toolName.replace("invoke_subagent_", ""),
            params: config.toolParameters[toolName],
        }));

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

    const currentKbParams = selectedKbForConfig ? config.toolParameters[selectedKbForConfig] : null;
    const currentToolParams = selectedToolForConfig
        ? config.toolParameters[selectedToolForConfig]
        : null;

    // ----------------------------------------------------------------
    // Build steps: architecture selector + architecture-specific steps
    // ----------------------------------------------------------------
    const architectureStep = {
        title: "Architecture Type",
        content: (
            <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                <Container header={<Header variant="h2">Select Architecture Type</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        <FormField
                            label="Architecture"
                            description="Choose the agent architecture for this runtime"
                        >
                            <RadioGroup
                                value={architectureType}
                                onChange={({ detail }) =>
                                    setArchitectureType(detail.value as ArchitectureType)
                                }
                                items={[
                                    {
                                        value: "SINGLE",
                                        label: "Single Agent / Agents as Tools",
                                        description:
                                            "A single agent with tools, knowledge bases, MCP servers, and optional sub-agents invoked as tools",
                                    },
                                    {
                                        value: "SWARM",
                                        label: "Swarm",
                                        description:
                                            "Multiple specialized agents that collaborate via handoffs",
                                    },
                                ]}
                            />
                        </FormField>
                    </SpaceBetween>
                </Container>
            </div>
        ),
    };

    const architectureSpecificSteps =
        architectureType === "SINGLE"
            ? getSingleAgentSteps({
                  config,
                  setConfig,
                  modelOptions,
                  availableToolsOptions,
                  availableSubAgents,
                  availableMcpServersOptions,
                  availableKnowledgeBases,
                  selectedToolsData,
                  selectedSubAgentsData,
                  selectedMcpServersData,
                  selectedKnowledgeBasesData,
                  knowledgeBaseIsSupported,
                  isCreating,
                  addTool,
                  removeTool,
                  addSubAgent,
                  addMcpServer,
                  removeMcpServer,
                  addKnowledgeBase,
                  openConfigureModal,
              })
            : getSwarmAgentSteps({
                  config,
                  setConfig,
                  swarmConfig,
                  setSwarmConfig,
                  availableAgents,
                  isCreating,
                  architectureType,
                  addAgentReference,
                  removeAgentReference,
                  updateAgentReferenceEndpoint,
                  getSwarmAgentNames,
              });

    const steps = isNewVersion
        ? [...architectureSpecificSteps]
        : [architectureStep, ...architectureSpecificSteps];

    const isStepValid = (stepIndex: number) => {
        if (!isNewVersion) {
            if (stepIndex === 0) return true; // Architecture type step
            const archStepIndex = stepIndex - 1;
            return architectureType === "SINGLE"
                ? isSingleAgentStepValid(archStepIndex, config)
                : isSwarmStepValid(archStepIndex, config, swarmConfig);
        }
        // New version: no architecture step offset
        return architectureType === "SINGLE"
            ? isSingleAgentStepValid(stepIndex, config)
            : isSwarmStepValid(stepIndex, config, swarmConfig);
    };

    // ----------------------------------------------------------------
    // Wizard shell + configure modal
    // ----------------------------------------------------------------
    const wizardContent = (
        <Wizard
            i18nStrings={{
                stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
                collapsedStepsLabel: (stepNumber, stepsCount) =>
                    `Step ${stepNumber} of ${stepsCount}`,
                navigationAriaLabel: "Steps",
                cancelButton: "Cancel",
                previousButton: "Previous",
                nextButton: "Next",
                submitButton: isCreating ? "Creating..." : "Create Runtime",
            }}
            onNavigate={({ detail }) => setActiveStepIndex(detail.requestedStepIndex)}
            activeStepIndex={activeStepIndex}
            onCancel={onCancel}
            onSubmit={() =>
                onSubmit({
                    ...config,
                    architectureType,
                    ...(architectureType === "SWARM" ? { swarmConfig } : {}),
                })
            }
            steps={steps.map((step) => ({
                title: step.title,
                content: step.content,
            }))}
            isLoadingNextStep={!isStepValid(activeStepIndex) || isCreating}
        />
    );

    return (
        <>
            {asPage ? (
                wizardContent
            ) : (
                <Modal
                    visible={true}
                    onDismiss={onCancel}
                    header="Create AgentCore Runtime Endpoint"
                    size="max"
                >
                    {wizardContent}
                </Modal>
            )}

            <Modal
                visible={configureModalVisible}
                onDismiss={closeConfigureModal}
                header={
                    selectedKbForConfig
                        ? "Configure Knowledge Base"
                        : `Configure ${selectedToolForConfig}`
                }
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            <Button variant="link" onClick={closeConfigureModal}>
                                Cancel
                            </Button>
                            <Button variant="primary" onClick={closeConfigureModal}>
                                Save
                            </Button>
                        </SpaceBetween>
                    </Box>
                }
            >
                {selectedKbForConfig && (
                    <SpaceBetween direction="vertical" size="l">
                        <FormField
                            label="Number of Results"
                            description="Number of documents to retrieve"
                        >
                            <Input
                                type="number"
                                value={
                                    currentKbParams?.retrieval_cfg?.vectorSearchConfiguration
                                        ?.numberOfResults || "5"
                                }
                                onChange={({ detail }) =>
                                    updateToolParameter(
                                        selectedKbForConfig,
                                        "retrieval_cfg.vectorSearchConfiguration.numberOfResults",
                                        detail.value,
                                    )
                                }
                                placeholder="5"
                            />
                        </FormField>

                        <FormField
                            label="Enable Reranking"
                            description="Enable document reranking to improve retrieval relevance"
                        >
                            <Checkbox
                                checked={enableReranking[selectedKbForConfig] || false}
                                onChange={({ detail }) => {
                                    setEnableReranking((prev) => ({
                                        ...prev,
                                        [selectedKbForConfig]: detail.checked,
                                    }));

                                    if (detail.checked) {
                                        updateToolParameter(
                                            selectedKbForConfig,
                                            "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.type",
                                            "BEDROCK_RERANKING_MODEL",
                                        );
                                        updateToolParameter(
                                            selectedKbForConfig,
                                            "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.bedrockRerankingConfiguration.modelConfiguration.modelArn",
                                            rerankingModelOptions.length > 0
                                                ? rerankingModelOptions[0].value
                                                : "cohere.rerank-v3-5:0",
                                        );
                                        updateToolParameter(
                                            selectedKbForConfig,
                                            "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.bedrockRerankingConfiguration.numberOfResults",
                                            "5",
                                        );
                                    } else {
                                        updateToolParameter(
                                            selectedKbForConfig,
                                            "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration",
                                            undefined,
                                        );
                                    }
                                }}
                            >
                                Enable reranking for improved relevance
                            </Checkbox>
                        </FormField>

                        {enableReranking[selectedKbForConfig] && (
                            <>
                                <FormField
                                    label="Reranking Model"
                                    description="Select the reranking model to use for improving document relevance"
                                >
                                    <Select
                                        selectedOption={
                                            currentKbParams?.retrieval_cfg
                                                ?.vectorSearchConfiguration?.rerankingConfiguration
                                                ?.bedrockRerankingConfiguration?.modelConfiguration
                                                ?.modelArn
                                                ? rerankingModelOptions.find(
                                                      (option) =>
                                                          option.value ===
                                                          currentKbParams.retrieval_cfg
                                                              ?.vectorSearchConfiguration
                                                              ?.rerankingConfiguration
                                                              ?.bedrockRerankingConfiguration
                                                              ?.modelConfiguration?.modelArn,
                                                  ) || null
                                                : rerankingModelOptions.length > 0
                                                  ? rerankingModelOptions[0]
                                                  : null
                                        }
                                        onChange={({ detail }) => {
                                            if (detail.selectedOption?.value) {
                                                updateToolParameter(
                                                    selectedKbForConfig,
                                                    "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.type",
                                                    "BEDROCK_RERANKING_MODEL",
                                                );
                                                updateToolParameter(
                                                    selectedKbForConfig,
                                                    "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.bedrockRerankingConfiguration.modelConfiguration.modelArn",
                                                    detail.selectedOption.value,
                                                );
                                            }
                                        }}
                                        options={rerankingModelOptions}
                                        placeholder="Select a reranking model..."
                                    />
                                </FormField>

                                <FormField
                                    label="Number of Results After Reranking"
                                    description="Number of documents to return after reranking"
                                >
                                    <Input
                                        type="number"
                                        value={
                                            currentKbParams?.retrieval_cfg
                                                ?.vectorSearchConfiguration?.rerankingConfiguration
                                                ?.bedrockRerankingConfiguration?.numberOfResults ||
                                            "5"
                                        }
                                        onChange={({ detail }) =>
                                            updateToolParameter(
                                                selectedKbForConfig,
                                                "retrieval_cfg.vectorSearchConfiguration.rerankingConfiguration.bedrockRerankingConfiguration.numberOfResults",
                                                detail.value,
                                            )
                                        }
                                        placeholder="5"
                                    />
                                </FormField>
                            </>
                        )}

                        <FormField
                            label="Search Type Configuration"
                            description="Configure the search strategy for retrieval"
                        >
                            <Checkbox
                                checked={enableSearchType[selectedKbForConfig] || false}
                                onChange={({ detail }) => {
                                    setEnableSearchType((prev) => ({
                                        ...prev,
                                        [selectedKbForConfig]: detail.checked,
                                    }));

                                    if (!detail.checked) {
                                        setConfig((prev) => {
                                            const newToolParameters = { ...prev.toolParameters };
                                            const kbParams = {
                                                ...newToolParameters[selectedKbForConfig],
                                            };
                                            if (kbParams.retrieval_cfg?.vectorSearchConfiguration) {
                                                const vectorConfig = {
                                                    ...kbParams.retrieval_cfg
                                                        .vectorSearchConfiguration,
                                                };
                                                delete vectorConfig.overrideSearchType;
                                                kbParams.retrieval_cfg = {
                                                    ...kbParams.retrieval_cfg,
                                                    vectorSearchConfiguration: vectorConfig,
                                                };
                                                newToolParameters[selectedKbForConfig] = kbParams;
                                            }
                                            return {
                                                ...prev,
                                                toolParameters: newToolParameters,
                                            };
                                        });
                                    }
                                }}
                            >
                                Enable Search Type selection
                            </Checkbox>
                        </FormField>

                        {enableSearchType[selectedKbForConfig] && (
                            <FormField
                                label="Search Type"
                                description="Select between semantic or hybrid search"
                            >
                                <Select
                                    selectedOption={
                                        currentKbParams?.retrieval_cfg?.vectorSearchConfiguration
                                            ?.overrideSearchType
                                            ? {
                                                  label: currentKbParams.retrieval_cfg
                                                      .vectorSearchConfiguration.overrideSearchType,
                                                  value: currentKbParams.retrieval_cfg
                                                      .vectorSearchConfiguration.overrideSearchType,
                                              }
                                            : null
                                    }
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption?.value) {
                                            updateToolParameter(
                                                selectedKbForConfig,
                                                "retrieval_cfg.vectorSearchConfiguration.overrideSearchType",
                                                detail.selectedOption.value,
                                            );
                                        }
                                    }}
                                    options={[
                                        { label: "SEMANTIC", value: SearchType.SEMANTIC },
                                        { label: "HYBRID", value: SearchType.HYBRID },
                                    ]}
                                    placeholder="Select search type..."
                                />
                            </FormField>
                        )}
                    </SpaceBetween>
                )}
                {selectedToolForConfig && selectedToolForConfig.startsWith("invoke_subagent_") && (
                    <SpaceBetween direction="vertical" size="l">
                        <FormField label="Agent Name" description="The sub-agent to invoke">
                            <Input value={currentToolParams?.agentName || ""} disabled />
                        </FormField>
                        <FormField
                            label="Endpoint/Qualifier"
                            description="Select the endpoint qualifier for the sub-agent"
                        >
                            <Select
                                placeholder="Select an endpoint..."
                                options={availableEndpoints.map((endpoint) => ({
                                    label: endpoint,
                                    value: endpoint,
                                }))}
                                selectedOption={
                                    currentToolParams?.qualifier
                                        ? {
                                              label: currentToolParams.qualifier,
                                              value: currentToolParams.qualifier,
                                          }
                                        : null
                                }
                                onChange={({ detail }) => {
                                    if (detail.selectedOption?.value) {
                                        updateToolParameter(
                                            selectedToolForConfig,
                                            "qualifier",
                                            detail.selectedOption.value,
                                        );
                                    }
                                }}
                                disabled={availableEndpoints.length === 0}
                            />
                        </FormField>
                        <FormField
                            label="Role"
                            description="Describe the role of this sub-agent for the orchestrator"
                        >
                            <Textarea
                                value={currentToolParams?.role || ""}
                                onChange={({ detail }) =>
                                    updateToolParameter(selectedToolForConfig, "role", detail.value)
                                }
                                placeholder="Enter the role of this sub-agent..."
                                rows={4}
                            />
                        </FormField>
                    </SpaceBetween>
                )}
            </Modal>
        </>
    );
}
