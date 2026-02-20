// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useMemo, useState } from "react";

import {
    Alert,
    Box,
    Button,
    Checkbox,
    ColumnLayout,
    Container,
    FormField,
    Header,
    Icon,
    Input,
    Modal,
    Popover,
    RadioGroup,
    Select,
    SpaceBetween,
    Table,
    Textarea,
    Wizard,
} from "@cloudscape-design/components";
import ReactMarkdown from "react-markdown";
import { KnowledgeBase, McpServer, RuntimeSummary, Tool } from "../../API";
import { AppContext } from "../../common/app-context";
import {
    listAgentEndpoints as listAgentEndpointsQuery,
    listAvailableMcpServers as listAvailableMcpServersQuery,
    listAvailableTools as listAvailableToolsQuery,
    listKnowledgeBases as listKnowledgeBasesQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";
import {
    AgentCoreRuntimeConfiguration,
    ArchitectureType,
    SearchType,
    SwarmConfiguration,
} from "./types";

// Set of dangerous keys that could lead to prototype pollution
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Helper function to check for prototype pollution attacks
const isSafePropertyKey = (key: string): boolean => {
    return !DANGEROUS_KEYS.has(key);
};

// Safe deep property setter that prevents prototype pollution using recursion
const safeDeepSetRecursive = (
    obj: Record<string, any>,
    keys: readonly string[],
    keyIndex: number,
    value: any,
): Record<string, any> => {
    // Base case: we've reached the final key
    if (keyIndex === keys.length - 1) {
        const finalKey = keys[keyIndex];
        return { ...obj, [finalKey]: value };
    }

    // Recursive case: need to go deeper
    const currentKey = keys[keyIndex];
    const currentValue = Object.prototype.hasOwnProperty.call(obj, currentKey)
        ? obj[currentKey]
        : null;
    const nestedObj =
        typeof currentValue === "object" && currentValue !== null
            ? currentValue
            : Object.create(null);

    return {
        ...obj,
        [currentKey]: safeDeepSetRecursive(nestedObj, keys, keyIndex + 1, value),
    };
};

// Safe deep property setter that prevents prototype pollution
const safeDeepSet = <T extends Record<string, any>>(obj: T, path: string, value: any): T => {
    const keys = path.split(".");

    // Validate all keys upfront
    if (!keys.every(isSafePropertyKey)) {
        console.error("Invalid property path detected - potential prototype pollution");
        return obj;
    }

    return safeDeepSetRecursive(obj, keys, 0, value) as T;
};

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
    const [swarmConfig, setSwarmConfig] = useState<SwarmConfiguration>({
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
    });


    // Initialize enableReranking and enableSearchType from initialData on mount
    useEffect(() => {
        if (initialData?.toolParameters) {
            const rerankingStates: { [key: string]: boolean } = {};
            const searchTypeStates: { [key: string]: boolean } = {};

            Object.keys(initialData.toolParameters).forEach((toolName) => {
                if (toolName.startsWith("retrieve_from_kb_")) {
                    const toolParams = initialData.toolParameters![toolName];

                    // Check for reranking configuration
                    const hasRerankingConfig =
                        toolParams?.retrieval_cfg?.vectorSearchConfiguration?.rerankingConfiguration
                            ?.bedrockRerankingConfiguration?.numberOfResults;
                    if (hasRerankingConfig) {
                        rerankingStates[toolName] = true;
                    }

                    // Check for search type configuration
                    const hasOverrideSearchType =
                        toolParams?.retrieval_cfg?.vectorSearchConfiguration?.overrideSearchType;
                    if (hasOverrideSearchType) {
                        searchTypeStates[toolName] = true;
                    }
                }
            });

            if (Object.keys(rerankingStates).length > 0) {
                setEnableReranking(rerankingStates);
            }
            if (Object.keys(searchTypeStates).length > 0) {
                setEnableSearchType(searchTypeStates);
            }
        }
    }, []); // Run once on mount

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
            parameters: {
                temperature: 0.2,
                maxTokens: 3000,
            },
        },
    });

    const conversationManagerOptions = [
        { label: "Sliding Window", value: "sliding_window" },
        { label: "Summarizing", value: "summarizing" },
        { label: "None", value: "null" },
    ];

    const apiClient = useMemo(() => generateClient(), []);

    useEffect(() => {
        // Guard: wait until appConfig is loaded
        if (!appConfig) return;

        let isCancelled = false;

        const fetchData = async () => {
            try {
                const knowledgeBaseSupported = appConfig?.knowledgeBaseIsSupported ?? false;

                const [kbResult, toolsResult, mcpServersResult, agentsResult] = await Promise.all([
                    knowledgeBaseSupported
                        ? apiClient.graphql({ query: listKnowledgeBasesQuery })
                        : Promise.resolve({ data: { listKnowledgeBases: [] } }),
                    apiClient.graphql({ query: listAvailableToolsQuery }),
                    apiClient.graphql({ query: listAvailableMcpServersQuery }),
                    apiClient.graphql({ query: listRuntimeAgentsQuery }),
                ]);

                if (isCancelled) return;

                setKnowledgeBases(kbResult.data!.listKnowledgeBases);
                if (toolsResult.data?.listAvailableTools) {
                    setAvailableTools(toolsResult.data.listAvailableTools);
                }
                if (mcpServersResult.data?.listAvailableMcpServers) {
                    setAvailableMcpServers(mcpServersResult.data.listAvailableMcpServers);
                }
                if (agentsResult.data?.listRuntimeAgents) {
                    setAvailableAgents(agentsResult.data.listRuntimeAgents);
                }
            } catch (error) {
                console.error("Failed to fetch data:", error);
            }
        };
        fetchData();

        return () => {
            isCancelled = true;
        };
    }, [appConfig, apiClient]);

    useEffect(() => {
        if (appConfig && appConfig.aws_bedrock_supported_models) {
            const models = Object.entries(appConfig.aws_bedrock_supported_models).map(
                ([label, value]) => {
                    const modelValue = value.replace(
                        "[REGION-PREFIX]",
                        appConfig.aws_project_region.split("-")[0],
                    );
                    return { label, value: modelValue };
                },
            );
            setModelOptions(models);

            if (!config.modelInferenceParameters.modelId) {
                const defaultModel = models.find(
                    (model) =>
                        model.label.toLowerCase().includes("claude") &&
                        model.label.toLowerCase().includes("haiku") &&
                        model.label.toLowerCase().includes("4.5"),
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

            // Set up reranking models from configuration
            if (appConfig && appConfig.aws_bedrock_supported_reranking_models) {
                console.log(
                    "Reranking models config:",
                    appConfig.aws_bedrock_supported_reranking_models,
                );
                const rerankingModels = Object.entries(
                    appConfig.aws_bedrock_supported_reranking_models,
                ).map(([label, value]) => {
                    return { label, value: value };
                });
                console.log("Processed reranking models:", rerankingModels);
                setRerankingModelOptions(rerankingModels);
            } else {
                console.log(
                    "No reranking models found in appConfig:",
                    appConfig?.aws_bedrock_supported_reranking_models,
                );
            }
        }
    }, [appConfig, config.modelInferenceParameters.modelId]);

    const addTool = (toolName: string | undefined) => {
        if (!toolName || toolName === "retrieve_from_kb" || config.tools.includes(toolName)) return;

        setConfig((prev) => ({
            ...prev,
            tools: [...prev.tools, toolName],
            toolParameters: {
                ...prev.toolParameters,
                [toolName]: {},
            },
        }));
    };

    const addMcpServer = (serverName: string | undefined) => {
        if (!serverName || config.mcpServers.includes(serverName)) return;

        setConfig((prev) => ({
            ...prev,
            mcpServers: [...prev.mcpServers, serverName],
        }));
    };

    const removeMcpServer = (serverName: string) => {
        setConfig((prev) => ({
            ...prev,
            mcpServers: prev.mcpServers.filter((server) => server !== serverName),
        }));
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

    const removeTool = (toolName: string) => {
        setConfig((prev) => {
            const newToolParameters = { ...prev.toolParameters };
            delete newToolParameters[toolName];
            return {
                ...prev,
                tools: prev.tools.filter((tool) => tool !== toolName),
                toolParameters: newToolParameters,
            };
        });
    };

    const addKnowledgeBase = (kbId: string | undefined) => {
        if (!kbId) return;
        const toolName = `retrieve_from_kb_${kbId}`;

        setConfig((prev) => ({
            ...prev,
            tools: [...prev.tools, toolName],
            toolParameters: {
                ...prev.toolParameters,
                [toolName]: {
                    retrieval_cfg: {
                        vectorSearchConfiguration: {
                            numberOfResults: "5",
                        },
                    },
                    kb_id: kbId,
                },
            },
        }));
    };

    const updateToolParameter = (toolName: string, paramPath: string, value: any) => {
        setConfig((prev) => {
            // Validate toolName to prevent prototype pollution
            if (DANGEROUS_KEYS.has(toolName)) {
                console.error("Invalid tool name detected - potential prototype pollution");
                return prev;
            }

            const currentToolParams = prev.toolParameters[toolName] || {};
            const updatedToolParams = safeDeepSet(currentToolParams, paramPath, value);

            // safeDeepSet always creates a new object on success via spread operator.
            // Same reference means validation failed (dangerous key detected).
            if (updatedToolParams === currentToolParams) {
                return prev;
            }

            return {
                ...prev,
                toolParameters: {
                    ...prev.toolParameters,
                    [toolName]: updatedToolParams,
                },
            };
        });
    };

    const openConfigureModal = async (toolName: string) => {
        if (toolName.startsWith("retrieve_from_kb_")) {
            setSelectedKbForConfig(toolName);

            // Check if overrideSearchType exists in config and update enableSearchType
            const hasOverrideSearchType =
                config.toolParameters[toolName]?.retrieval_cfg?.vectorSearchConfiguration
                    ?.overrideSearchType;

            setEnableSearchType((prev) => ({
                ...prev,
                [toolName]: !!hasOverrideSearchType,
            }));

            // Check if reranking configuration exists and update enableReranking
            const hasRerankingConfig =
                config.toolParameters[toolName]?.retrieval_cfg?.vectorSearchConfiguration
                    ?.rerankingConfiguration?.bedrockRerankingConfiguration?.numberOfResults;

            setEnableReranking((prev) => ({
                ...prev,
                [toolName]: !!hasRerankingConfig,
            }));
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

    const isStepValid = (stepIndex: number) => {
        // Step 0 is always Architecture Type - always valid
        if (stepIndex === 0) return true;

        if (architectureType === "SINGLE") {
            // Step 1 = Basic Config
            if (stepIndex === 1) {
                const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
                return (
                    config.instructions.trim() !== "" &&
                    config.agentName.trim() !== "" &&
                    agentNamePattern.test(config.agentName)
                );
            }
            // Step 4 = Tools Config (index shifts by 1 due to architecture step)
            if (stepIndex === 4) {
                return !config.tools.some((tool) => {
                    return (
                        tool.startsWith("invoke_subagent_") &&
                        !config.toolParameters[tool]?.agentName
                    );
                });
            }
        } else {
            // SWARM: Step 1 = Swarm Configuration (agent name + agents + entry agent)
            if (stepIndex === 1) {
                const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
                const hasAgentName =
                    config.agentName.trim() !== "" &&
                    agentNamePattern.test(config.agentName);
                const hasAgents = swarmConfig.agentReferences.length > 0;
                const hasEntryAgent = swarmConfig.entryAgent.trim() !== "";
                return hasAgentName && hasAgents && hasEntryAgent;
            }
        }
        return true;
    };

    const availableKnowledgeBases = knowledgeBases
        .filter((kb) => !config.tools.some((tool) => tool === `retrieve_from_kb_${kb.id}`))
        .map((kb: KnowledgeBase) => ({
            label: kb.description || kb.name,
            value: kb.id,
        }));

    const availableToolsOptions = availableTools
        .filter((tool) => !tool.invokesSubAgent && !config.tools.includes(tool.name))
        .map((tool) => ({
            label: tool.name,
            value: tool.name,
            description: tool.description,
        }));

    const availableSubAgents = availableAgents
        .filter(
            (agent) =>
                agent.agentName !== config.agentName &&
                !config.tools.includes(`invoke_subagent_${agent.agentName}`),
        )
        .map((agent) => ({
            label: agent.agentName,
            value: agent.agentName,
        }));

    const availableMcpServersOptions = availableMcpServers
        .filter((mcpServer) => !config.mcpServers.includes(mcpServer.name))
        .map((mcpServer) => ({
            label: mcpServer.name,
            value: mcpServer.name,
            description: mcpServer.description,
        }));

    const selectedMcpServersData = config.mcpServers.map((serverName) => {
        const serverInfo = availableMcpServers.find((s) => s.name === serverName);
        return {
            name: serverName,
            description: serverInfo?.description || "No description available",
            // identityName: serverInfo?.identityName || "Unknown",
            mcpUrl: serverInfo?.mcpUrl || "",
        };
    });

    const selectedToolsData = config.tools
        .filter(
            (tool) => !tool.startsWith("retrieve_from_kb_") && !tool.startsWith("invoke_subagent_"),
        )
        .map((toolName) => {
            const toolInfo = availableTools.find((t) => t.name === toolName);
            return {
                name: toolName,
                description: toolInfo?.description || "No description available",
            };
        });

    const selectedSubAgentsData = config.tools
        .filter((tool) => tool.startsWith("invoke_subagent_"))
        .map((toolName) => {
            const agentName = toolName.replace("invoke_subagent_", "");
            const params = config.toolParameters[toolName];
            return {
                toolName,
                agentName,
                params,
            };
        });

    const selectedKnowledgeBasesData = config.tools
        .filter((tool) => tool.startsWith("retrieve_from_kb_"))
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

    const stepMinHeight = "62vh";

    const knowledgeBaseIsSupported = appConfig?.knowledgeBaseIsSupported ?? false;

    const steps = [
        {
            title: "Architecture Type",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
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
        },
        ...(architectureType === "SINGLE"
            ? [
                  {
                      title: "Basic Configuration",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
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
                                        conversationManagerOptions.find(
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
                                    options={conversationManagerOptions}
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
                <div style={{ minHeight: stepMinHeight }}>
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
                <div style={{ minHeight: stepMinHeight }}>
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
                <div style={{ minHeight: stepMinHeight }}>
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

                            <FormField
                                label="Available Sub-Agents"
                                description="Sub-agents that this orchestrator can invoke as tools"
                            >
                                <Select
                                    placeholder={
                                        availableSubAgents.length === 0
                                            ? "No additional sub-agents available"
                                            : "Select a sub-agent to add as a tool"
                                    }
                                    options={availableSubAgents}
                                    disabled={availableSubAgents.length === 0}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption) {
                                            addSubAgent(detail.selectedOption.value);
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

                            <Container
                                header={<Header variant="h3">Selected Sub-Agents (Tools)</Header>}
                            >
                                {selectedSubAgentsData.length === 0 ? (
                                    <Alert type="info">No sub-agents selected</Alert>
                                ) : (
                                    <Table
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Agent Name",
                                                cell: (item) => item.agentName,
                                            },
                                            {
                                                id: "parameters",
                                                header: "Parameters",
                                                cell: (item) => {
                                                    const isConfigured =
                                                        item.params?.qualifier && item.params?.role;
                                                    return (
                                                        <Button
                                                            variant="normal"
                                                            onClick={() =>
                                                                openConfigureModal(item.toolName)
                                                            }
                                                        >
                                                            {isConfigured
                                                                ? "Configured"
                                                                : "Configure"}
                                                        </Button>
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
                                                        onClick={() => removeTool(item.toolName)}
                                                    />
                                                ),
                                            },
                                        ]}
                                        items={selectedSubAgentsData}
                                        loadingText="Loading sub-agents"
                                        empty={
                                            <Box textAlign="center" color="inherit">
                                                <b>No sub-agents selected</b>
                                                <Box
                                                    padding={{ bottom: "s" }}
                                                    variant="p"
                                                    color="inherit"
                                                >
                                                    Select sub-agents from the dropdown above.
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
                <div style={{ minHeight: stepMinHeight }}>
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
                                            // {
                                            //     id: "identityName",
                                            //     header: "Identity Name",
                                            //     cell: (item) => item.identityName,
                                            // },
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
              ]
            : []),
        // Only include Knowledge Bases step if knowledge base is supported and architecture is SINGLE
        ...(knowledgeBaseIsSupported && architectureType === "SINGLE"
            ? [
                  {
                      title: "Knowledge Bases",
                      content: (
                          <div style={{ minHeight: stepMinHeight }}>
                              <Container
                                  header={<Header variant="h2">Configure Knowledge Bases</Header>}
                              >
                                  <SpaceBetween direction="vertical" size="l">
                                      <FormField label="Available Knowledge Bases">
                                          <Select
                                              placeholder={
                                                  availableKnowledgeBases.length === 0
                                                      ? "No additional knowledge bases available"
                                                      : "Select a knowledge base to add"
                                              }
                                              options={availableKnowledgeBases}
                                              disabled={availableKnowledgeBases.length === 0}
                                              onChange={({ detail }) => {
                                                  if (detail.selectedOption) {
                                                      addKnowledgeBase(detail.selectedOption.value);
                                                  }
                                              }}
                                              selectedOption={null}
                                          />
                                      </FormField>

                                      <Container
                                          header={
                                              <Header variant="h3">Selected Knowledge Bases</Header>
                                          }
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
                                                                      openConfigureModal(
                                                                          item.toolName,
                                                                      )
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
                                                                  onClick={() =>
                                                                      removeTool(item.toolName)
                                                                  }
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
                                                              Select knowledge bases from the
                                                              dropdown above.
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
              ]
            : []),
        ...(architectureType === "SINGLE"
            ? [
                  {
                      title: "Review",
                      content: (
                          <div style={{ minHeight: stepMinHeight }}>
                              <Container
                                  header={<Header variant="h2">Review Configuration</Header>}
                              >
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
                  },
              ]
            : [
                  {
                      title: "Swarm Configuration",
                      content: (
                          <div style={{ minHeight: stepMinHeight }}>
                              <SpaceBetween direction="vertical" size="l">
                                  <Container header={<Header variant="h2">Agent Name</Header>}>
                                      <FormField
                                          label="Agent Name"
                                          description="Enter a unique name for your swarm agent"
                                          errorText={
                                              config.agentName.trim() === ""
                                                  ? "Agent name is required"
                                                  : !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(
                                                          config.agentName,
                                                      )
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

                                  <Container header={<Header variant="h2">Agent Source</Header>}>
                                      <SpaceBetween direction="vertical" size="l">
                                              <SpaceBetween direction="vertical" size="m">
                                                  <FormField label="Select Agent">
                                                      <Select
                                                          placeholder="Select an existing agent to reference"
                                                          options={availableAgents
                                                              .filter(
                                                                  (a) =>
                                                                      !swarmConfig.agentReferences.some(
                                                                          (r) =>
                                                                              r.agentName ===
                                                                              a.agentName,
                                                                      ),
                                                              )
                                                              .map((a) => ({
                                                                  label: a.agentName,
                                                                  value: a.agentName,
                                                              }))}
                                                          onChange={({ detail }) => {
                                                              if (detail.selectedOption?.value) {
                                                                  addAgentReference(
                                                                      detail.selectedOption.value,
                                                                  );
                                                              }
                                                          }}
                                                          selectedOption={null}
                                                      />
                                                  </FormField>
                                                  {swarmConfig.agentReferences.length === 0 ? (
                                                      <Alert type="info">
                                                          No agent references added yet.
                                                      </Alert>
                                                  ) : (
                                                      <Table
                                                          items={swarmConfig.agentReferences}
                                                          columnDefinitions={[
                                                              {
                                                                  id: "agentName",
                                                                  header: "Agent Name",
                                                                  cell: (item) => item.agentName,
                                                                  isRowHeader: true,
                                                              },
                                                              {
                                                                  id: "endpointName",
                                                                  header: "Endpoint",
                                                                  cell: (item) => {
                                                                      const idx = swarmConfig.agentReferences.indexOf(item);
                                                                      return (
                                                                          <Input
                                                                              value={
                                                                                  item.endpointName
                                                                              }
                                                                              onChange={({
                                                                                  detail,
                                                                              }) =>
                                                                                  updateAgentReferenceEndpoint(
                                                                                      idx,
                                                                                      detail.value,
                                                                                  )
                                                                              }
                                                                              placeholder="DEFAULT"
                                                                          />
                                                                      );
                                                                  },
                                                              },
                                                              {
                                                                  id: "actions",
                                                                  header: "Actions",
                                                                  cell: (item) => {
                                                                      const idx = swarmConfig.agentReferences.indexOf(item);
                                                                      return (
                                                                          <Button
                                                                              variant="icon"
                                                                              iconName="close"
                                                                              onClick={() =>
                                                                                  removeAgentReference(idx)
                                                                              }
                                                                          />
                                                                      );
                                                                  },
                                                              },
                                                          ]}
                                                      />
                                                  )}
                                              </SpaceBetween>
                                      </SpaceBetween>
                                  </Container>

                                  <Container
                                      header={<Header variant="h2">Entry Agent</Header>}
                                  >
                                      <FormField
                                          label="Entry Agent"
                                          description="The agent that receives the initial user message"
                                      >
                                          <Select
                                              placeholder="Select entry agent"
                                              options={getSwarmAgentNames().map((name) => ({
                                                  label: name,
                                                  value: name,
                                              }))}
                                              selectedOption={
                                                  swarmConfig.entryAgent
                                                      ? {
                                                            label: swarmConfig.entryAgent,
                                                            value: swarmConfig.entryAgent,
                                                        }
                                                      : null
                                              }
                                              onChange={({ detail }) =>
                                                  setSwarmConfig((prev) => ({
                                                      ...prev,
                                                      entryAgent:
                                                          detail.selectedOption?.value || "",
                                                  }))
                                              }
                                              disabled={getSwarmAgentNames().length === 0}
                                          />
                                      </FormField>
                                  </Container>

                                  <Container
                                      header={
                                          <Header variant="h2">Orchestrator Settings</Header>
                                      }
                                  >
                                      <ColumnLayout columns={2} variant="text-grid">
                                          <FormField
                                              label="Max Handoffs"
                                              description="Maximum agent-to-agent handoffs"
                                          >
                                              <Input
                                                  type="number"
                                                  value={swarmConfig.orchestrator.maxHandoffs.toString()}
                                                  onChange={({ detail }) =>
                                                      setSwarmConfig((prev) => ({
                                                          ...prev,
                                                          orchestrator: {
                                                              ...prev.orchestrator,
                                                              maxHandoffs:
                                                                  parseInt(detail.value) || 15,
                                                          },
                                                      }))
                                                  }
                                              />
                                          </FormField>
                                          <FormField
                                              label="Max Iterations"
                                              description="Maximum total iterations"
                                          >
                                              <Input
                                                  type="number"
                                                  value={swarmConfig.orchestrator.maxIterations.toString()}
                                                  onChange={({ detail }) =>
                                                      setSwarmConfig((prev) => ({
                                                          ...prev,
                                                          orchestrator: {
                                                              ...prev.orchestrator,
                                                              maxIterations:
                                                                  parseInt(detail.value) || 50,
                                                          },
                                                      }))
                                                  }
                                              />
                                          </FormField>
                                          <FormField
                                              label="Execution Timeout (s)"
                                              description="Total execution timeout in seconds"
                                          >
                                              <Input
                                                  type="number"
                                                  value={swarmConfig.orchestrator.executionTimeoutSeconds.toString()}
                                                  onChange={({ detail }) =>
                                                      setSwarmConfig((prev) => ({
                                                          ...prev,
                                                          orchestrator: {
                                                              ...prev.orchestrator,
                                                              executionTimeoutSeconds:
                                                                  parseFloat(detail.value) || 300,
                                                          },
                                                      }))
                                                  }
                                              />
                                          </FormField>
                                          <FormField
                                              label="Node Timeout (s)"
                                              description="Per-agent timeout in seconds"
                                          >
                                              <Input
                                                  type="number"
                                                  value={swarmConfig.orchestrator.nodeTimeoutSeconds.toString()}
                                                  onChange={({ detail }) =>
                                                      setSwarmConfig((prev) => ({
                                                          ...prev,
                                                          orchestrator: {
                                                              ...prev.orchestrator,
                                                              nodeTimeoutSeconds:
                                                                  parseFloat(detail.value) || 60,
                                                          },
                                                      }))
                                                  }
                                              />
                                          </FormField>
                                      </ColumnLayout>
                                  </Container>

                                  <Container
                                      header={
                                          <Header variant="h2">Conversation Manager</Header>
                                      }
                                  >
                                      <FormField label="Conversation Manager">
                                          <Select
                                              selectedOption={
                                                  conversationManagerOptions.find(
                                                      (opt) =>
                                                          opt.value ===
                                                          swarmConfig.conversationManager,
                                                  ) || null
                                              }
                                              onChange={({ detail }) =>
                                                  setSwarmConfig((prev) => ({
                                                      ...prev,
                                                      conversationManager:
                                                          (detail.selectedOption?.value ||
                                                              "sliding_window") as
                                                              | "null"
                                                              | "sliding_window"
                                                              | "summarizing",
                                                  }))
                                              }
                                              options={conversationManagerOptions}
                                          />
                                      </FormField>
                                  </Container>
                              </SpaceBetween>
                          </div>
                      ),
                  },
                  {
                      title: "Review",
                      content: (
                          <div style={{ minHeight: stepMinHeight }}>
                              <Container
                                  header={<Header variant="h2">Review Configuration</Header>}
                              >
                                  <SpaceBetween direction="vertical" size="m">
                                      {!isCreating && (
                                          <Alert type="info" header="Configuration Summary">
                                              Review your swarm agent configuration before creating.
                                          </Alert>
                                      )}
                                      <Box padding="m" variant="code">
                                          <pre style={{ margin: 0, overflow: "auto" }}>
                                              {JSON.stringify(
                                                  {
                                                      agentName: config.agentName,
                                                      architectureType,
                                                      swarmConfig,
                                                  },
                                                  null,
                                                  2,
                                              )}
                                          </pre>
                                      </Box>
                                  </SpaceBetween>
                              </Container>
                          </div>
                      ),
                  },
              ]),
    ];

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
                                        // Set up default reranking configuration
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
                                        // Remove overrideSearchType from config when unchecked
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
