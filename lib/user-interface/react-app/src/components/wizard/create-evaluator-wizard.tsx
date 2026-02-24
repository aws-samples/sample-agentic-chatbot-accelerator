// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useMemo, useState } from "react";

import {
    Alert,
    Box,
    Button,
    Container,
    FileUpload,
    FormField,
    Header,
    Icon,
    Input,
    Popover,
    Select,
    SpaceBetween,
    Table,
    Tabs,
    Textarea,
    Wizard,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../API";
import { AppContext } from "../../common/app-context";
import { EvaluatorType, TestCase, EvaluatorConfigType } from "../../common/types";
import {
    listAgentEndpoints as listAgentEndpointsQuery,
    listRuntimeAgents as listRuntimeAgentsQuery,
} from "../../graphql/queries";

// Configuration for a single evaluator instance
export interface EvaluatorConfig {
    id: string; // unique id for this evaluator instance
    type: EvaluatorType | string;
    rubric?: string;
}

export interface EvaluatorConfiguration {
    name: string;
    description: string;
    agentRuntimeId: string;
    agentRuntimeName: string;
    qualifier: string;
    modelId: string; // Model to use for evaluation
    passThreshold: number; // Pass rate threshold (0.0-1.0)
    evaluatorType: EvaluatorType | string; // Legacy - kept for backward compatibility
    customRubric?: string; // Legacy - kept for backward compatibility
    evaluators: EvaluatorConfig[]; // NEW: multiple evaluators
    testCases: TestCase[];
}

interface CreateEvaluatorWizardProps {
    onSubmit: (config: EvaluatorConfiguration) => void;
    onCancel: () => void;
    isCreating?: boolean;
}

const EVALUATOR_TYPE_OPTIONS = [
    { label: "Output Evaluator", value: EvaluatorType.OUTPUT, description: "Evaluates response accuracy and completeness against expected output" },
    { label: "Helpfulness Evaluator", value: EvaluatorType.HELPFULNESS, description: "Measures how helpful and useful the agent response is (requires trajectory)" },
    { label: "Faithfulness Evaluator", value: EvaluatorType.FAITHFULNESS, description: "Checks if the response is faithful to the source content (requires trajectory)" },
    { label: "Tool Selection Evaluator", value: EvaluatorType.TOOL_SELECTION, description: "Evaluates if the agent selected the correct tools (requires trajectory)" },
    { label: "Tool Parameter Evaluator", value: EvaluatorType.TOOL_PARAMETER, description: "Checks if tool parameters were correctly provided (requires trajectory)" },
];

// Evaluators that require a rubric
const EVALUATORS_REQUIRING_RUBRIC = [EvaluatorType.OUTPUT, EvaluatorType.TRAJECTORY, EvaluatorType.INTERACTIONS];

export default function CreateEvaluatorWizard({
    onSubmit,
    onCancel,
    isCreating = false,
}: CreateEvaluatorWizardProps) {
    const appConfig = useContext(AppContext);
    const apiClient = useMemo(() => generateClient(), []);

    // Get evaluator config from app config (CDK config)
    const evaluatorAppConfig: EvaluatorConfigType | undefined = appConfig?.evaluatorConfig;

    // State for model options
    const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);

    useEffect(() => {
        if (evaluatorAppConfig?.supportedModels && appConfig) {
            const models = Object.entries(evaluatorAppConfig.supportedModels).map(
                ([label, value]) => {
                    const modelValue = (value as string).replace(
                        "[REGION-PREFIX]",
                        appConfig.aws_project_region.split("-")[0],
                    );
                    return { label, value: modelValue };
                },
            );
            setModelOptions(models);
        }
    }, [evaluatorAppConfig, appConfig]);

    // Get default rubrics from config
    const defaultRubrics = useMemo(() => {
        return evaluatorAppConfig?.defaultRubrics || {};
    }, [evaluatorAppConfig]);

    const [activeStepIndex, setActiveStepIndex] = useState(0);
    const [availableAgents, setAvailableAgents] = useState<RuntimeSummary[]>([]);
    const [availableEndpoints, setAvailableEndpoints] = useState<string[]>([]);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [parseError, setParseError] = useState<string>("");
    const [testCasesJson, setTestCasesJson] = useState<string>("");
    const [inputMode, setInputMode] = useState<"file" | "json">("file");

    // Modal state for configuring evaluator rubric
    const [configModalVisible, setConfigModalVisible] = useState(false);
    const [selectedEvaluatorId, setSelectedEvaluatorId] = useState<string | null>(null);
    const [tempRubric, setTempRubric] = useState<string>("");

    const [config, setConfig] = useState<EvaluatorConfiguration>({
        name: "",
        description: "",
        agentRuntimeId: "",
        agentRuntimeName: "",
        qualifier: "",
        modelId: "",
        passThreshold: evaluatorAppConfig?.passThreshold || 0,
        evaluatorType: EvaluatorType.OUTPUT, // Legacy
        customRubric: "", // Legacy
        evaluators: [], // NEW
        testCases: [],
    });

    // Set default model ID when model options become available
    useEffect(() => {
        if (modelOptions.length > 0 && !config.modelId) {
            setConfig(prev => ({ ...prev, modelId: modelOptions[0].value }));
        }
    }, [modelOptions, config.modelId]);

    // Fetch available agents on mount
    useEffect(() => {
        if (!appConfig) return;

        const fetchAgents = async () => {
            try {
                const result = await apiClient.graphql({ query: listRuntimeAgentsQuery });
                const agents = result.data?.listRuntimeAgents || [];
                // Only show agents that are ready
                setAvailableAgents(agents.filter((a: RuntimeSummary) => a.status.toLowerCase() === "ready"));
            } catch (error) {
                console.error("Failed to fetch agents:", error);
            }
        };

        fetchAgents();
    }, [appConfig, apiClient]);

    // Fetch endpoints when agent is selected
    useEffect(() => {
        if (!config.agentRuntimeId) {
            setAvailableEndpoints([]);
            return;
        }

        const fetchEndpoints = async () => {
            try {
                const result = await apiClient.graphql({
                    query: listAgentEndpointsQuery,
                    variables: { agentRuntimeId: config.agentRuntimeId },
                });
                const endpoints = (result.data?.listAgentEndpoints || []).filter(
                    (e: string | null): e is string => e !== null
                );
                setAvailableEndpoints(endpoints);

                // Auto-select first endpoint
                if (endpoints.length > 0 && !config.qualifier) {
                    setConfig(prev => ({ ...prev, qualifier: endpoints[0] }));
                }
            } catch (error) {
                console.error("Failed to fetch endpoints:", error);
                setAvailableEndpoints([]);
            }
        };

        fetchEndpoints();
    }, [config.agentRuntimeId, apiClient]);

    // Parse test cases from JSON string
    const parseTestCasesJson = (jsonText: string): { cases: TestCase[], error: string } => {
        if (!jsonText.trim()) {
            return { cases: [], error: "" };
        }

        try {
            const parsed = JSON.parse(jsonText);

            // Validate test cases structure
            if (!Array.isArray(parsed)) {
                return { cases: [], error: "Test cases must be an array" };
            }

            const validatedCases: TestCase[] = parsed.map((item, index) => {
                // Only name and input are required
                if (!item.name || !item.input) {
                    throw new Error(`Test case ${index + 1} is missing required fields (name, input)`);
                }
                return {
                    name: item.name,
                    input: item.input,
                    expected_output: item.expected_output || "", // Optional
                    metadata: item.metadata || {},
                };
            });

            return { cases: validatedCases, error: "" };
        } catch (error) {
            return { cases: [], error: error instanceof Error ? error.message : "Failed to parse JSON" };
        }
    };

    // Handle file upload
    const handleFileUpload = async (files: File[]) => {
        setUploadedFiles(files);
        setParseError("");

        if (files.length === 0) {
            setConfig(prev => ({ ...prev, testCases: [] }));
            return;
        }

        const file = files[0];
        try {
            const text = await file.text();
            const { cases, error } = parseTestCasesJson(text);
            if (error) {
                setParseError(error);
                setConfig(prev => ({ ...prev, testCases: [] }));
            } else {
                setConfig(prev => ({ ...prev, testCases: cases }));
            }
        } catch (error) {
            setParseError(error instanceof Error ? error.message : "Failed to read file");
            setConfig(prev => ({ ...prev, testCases: [] }));
        }
    };

    // Handle JSON text input
    const handleJsonInput = (jsonText: string) => {
        setTestCasesJson(jsonText);
        const { cases, error } = parseTestCasesJson(jsonText);
        setParseError(error);
        setConfig(prev => ({ ...prev, testCases: cases }));
    };

    // Add evaluator
    const addEvaluator = (evaluatorType: string | undefined) => {
        if (!evaluatorType) return;

        const id = `${evaluatorType}-${Date.now()}`;
        const needsRubric = EVALUATORS_REQUIRING_RUBRIC.includes(evaluatorType as EvaluatorType);

        setConfig(prev => ({
            ...prev,
            evaluators: [
                ...prev.evaluators,
                {
                    id,
                    type: evaluatorType,
                    rubric: needsRubric ? defaultRubrics[evaluatorType] || "" : undefined,
                },
            ],
        }));
    };

    // Remove evaluator
    const removeEvaluator = (evaluatorId: string) => {
        setConfig(prev => ({
            ...prev,
            evaluators: prev.evaluators.filter(e => e.id !== evaluatorId),
        }));
    };

    // Open configure modal for evaluator
    const openConfigureModal = (evaluatorId: string) => {
        const evaluator = config.evaluators.find(e => e.id === evaluatorId);
        if (evaluator) {
            setSelectedEvaluatorId(evaluatorId);
            setTempRubric(evaluator.rubric || defaultRubrics[evaluator.type] || "");
            setConfigModalVisible(true);
        }
    };

    // Save evaluator configuration
    const saveEvaluatorConfig = () => {
        if (selectedEvaluatorId) {
            setConfig(prev => ({
                ...prev,
                evaluators: prev.evaluators.map(e =>
                    e.id === selectedEvaluatorId ? { ...e, rubric: tempRubric } : e
                ),
            }));
        }
        setConfigModalVisible(false);
        setSelectedEvaluatorId(null);
    };

    // Validation
    const isStepValid = (stepIndex: number): boolean => {
        switch (stepIndex) {
            case 0: // Basic Configuration
                return config.name.trim() !== "" && config.modelId !== "";
            case 1: // Agent Configuration
                return config.agentRuntimeId !== "" && config.qualifier !== "";
            case 2: // Evaluator Types
                return config.evaluators.length > 0;
            case 3: // Test Cases
                return config.testCases.length > 0;
            default:
                return true;
        }
    };

    const agentOptions = availableAgents.map(agent => ({
        label: agent.agentName,
        value: agent.agentRuntimeId,
    }));

    const endpointOptions = availableEndpoints.map(endpoint => ({
        label: endpoint,
        value: endpoint,
    }));

    // Get evaluator label
    const getEvaluatorLabel = (type: string) => {
        return EVALUATOR_TYPE_OPTIONS.find(opt => opt.value === type)?.label || type;
    };

    // Check if evaluator requires rubric
    const evaluatorRequiresRubric = (type: string) => {
        return EVALUATORS_REQUIRING_RUBRIC.includes(type as EvaluatorType);
    };

    const stepMinHeight = "50vh";

    const steps = [
        {
            title: "Basic Configuration",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
                    <Container header={<Header variant="h2">Evaluator Details</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="Evaluator Name"
                                description="Enter a unique name for this evaluator"
                                errorText={config.name.trim() === "" ? "Evaluator name is required" : ""}
                            >
                                <Input
                                    value={config.name}
                                    onChange={({ detail }) =>
                                        setConfig(prev => ({ ...prev, name: detail.value }))
                                    }
                                    placeholder="Enter evaluator name..."
                                />
                            </FormField>
                            <FormField
                                label="Description"
                                description="Provide a description for this evaluator (optional)"
                            >
                                <Textarea
                                    value={config.description}
                                    onChange={({ detail }) =>
                                        setConfig(prev => ({ ...prev, description: detail.value }))
                                    }
                                    placeholder="Enter evaluator description..."
                                    rows={4}
                                />
                            </FormField>
                            <FormField
                                label="Evaluation Model"
                                description="Select the LLM model to use for evaluation scoring"
                                errorText={config.modelId === "" ? "Evaluation model is required" : ""}
                            >
                                <Select
                                    selectedOption={
                                        modelOptions.find(opt => opt.value === config.modelId) || null
                                    }
                                    onChange={({ detail }) =>
                                        setConfig(prev => ({
                                            ...prev,
                                            modelId: detail.selectedOption?.value || config.modelId,
                                        }))
                                    }
                                    options={modelOptions}
                                    placeholder="Select evaluation model..."
                                />
                            </FormField>
                            <FormField
                                label="Pass Threshold"
                                description="Score threshold (0.0-1.0) above which a test case is considered passed"
                            >
                                <Input
                                    type="number"
                                    value={String(config.passThreshold)}
                                    onChange={({ detail }) => {
                                        const value = parseFloat(detail.value);
                                        if (!isNaN(value) && value >= 0 && value <= 1) {
                                            setConfig(prev => ({ ...prev, passThreshold: value }));
                                        }
                                    }}
                                    placeholder="0.8"
                                />
                            </FormField>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Agent Configuration",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
                    <Container header={<Header variant="h2">Select Agent Runtime</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="AgentCore Runtime"
                                description="Select the agent runtime to evaluate"
                                errorText={config.agentRuntimeId === "" ? "Agent runtime is required" : ""}
                            >
                                <Select
                                    selectedOption={
                                        config.agentRuntimeId
                                            ? agentOptions.find(opt => opt.value === config.agentRuntimeId) || null
                                            : null
                                    }
                                    onChange={({ detail }) => {
                                        const selectedAgent = availableAgents.find(
                                            a => a.agentRuntimeId === detail.selectedOption?.value
                                        );
                                        setConfig(prev => ({
                                            ...prev,
                                            agentRuntimeId: detail.selectedOption?.value || "",
                                            agentRuntimeName: selectedAgent?.agentName || "",
                                            qualifier: "", // Reset qualifier when agent changes
                                        }));
                                    }}
                                    options={agentOptions}
                                    placeholder="Select an agent runtime..."
                                    disabled={agentOptions.length === 0}
                                    empty="No agent runtimes available"
                                />
                            </FormField>

                            {config.agentRuntimeId && (
                                <FormField
                                    label="Endpoint/Qualifier"
                                    description="Select the endpoint qualifier for the agent"
                                    errorText={config.qualifier === "" ? "Endpoint is required" : ""}
                                >
                                    <Select
                                        selectedOption={
                                            config.qualifier
                                                ? endpointOptions.find(opt => opt.value === config.qualifier) || null
                                                : null
                                        }
                                        onChange={({ detail }) =>
                                            setConfig(prev => ({
                                                ...prev,
                                                qualifier: detail.selectedOption?.value || "",
                                            }))
                                        }
                                        options={endpointOptions}
                                        placeholder="Select an endpoint..."
                                        disabled={endpointOptions.length === 0}
                                        empty="No endpoints available"
                                    />
                                </FormField>
                            )}
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Evaluator Types",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
                    <Container header={<Header variant="h2">Configure Evaluators</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="Add Evaluator"
                                description="Select evaluator types to add. You can add multiple evaluators with different configurations."
                            >
                                <Select
                                    placeholder="Select an evaluator type to add"
                                    options={EVALUATOR_TYPE_OPTIONS.filter(
                                        opt => !config.evaluators.some(e => e.type === opt.value)
                                    )}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption) {
                                            addEvaluator(detail.selectedOption.value);
                                        }
                                    }}
                                    selectedOption={null}
                                    disabled={config.evaluators.length >= EVALUATOR_TYPE_OPTIONS.length}
                                    empty="All evaluator types have been added"
                                />
                            </FormField>

                            <Alert type="info" header="Multiple Evaluators">
                                You can add multiple evaluators to assess different aspects of the agent's response.
                                Each evaluator will run independently and provide separate scores.
                            </Alert>

                            <Container header={<Header variant="h3">Selected Evaluators ({config.evaluators.length})</Header>}>
                                {config.evaluators.length === 0 ? (
                                    <Alert type="warning">
                                        No evaluators selected. Please add at least one evaluator.
                                    </Alert>
                                ) : (
                                    <Table
                                        columnDefinitions={[
                                            {
                                                id: "type",
                                                header: "Evaluator Type",
                                                cell: item => getEvaluatorLabel(item.type),
                                                width: 200,
                                            },
                                            {
                                                id: "description",
                                                header: "Description",
                                                cell: item => {
                                                    const option = EVALUATOR_TYPE_OPTIONS.find(opt => opt.value === item.type);
                                                    return (
                                                        <Popover
                                                            dismissButton={false}
                                                            position="top"
                                                            size="medium"
                                                            triggerType="custom"
                                                            content={
                                                                <Box padding="xs">
                                                                    {option?.description || "No description available"}
                                                                </Box>
                                                            }
                                                        >
                                                            <Icon name="status-info" />
                                                        </Popover>
                                                    );
                                                },
                                                width: 100,
                                            },
                                            {
                                                id: "rubric",
                                                header: "Configuration",
                                                cell: item => {
                                                    if (evaluatorRequiresRubric(item.type)) {
                                                        return (
                                                            <Button
                                                                variant="normal"
                                                                onClick={() => openConfigureModal(item.id)}
                                                            >
                                                                {item.rubric ? "Edit Rubric" : "Configure"}
                                                            </Button>
                                                        );
                                                    }
                                                    return <span style={{ color: "#666" }}>No configuration needed</span>;
                                                },
                                            },
                                            {
                                                id: "actions",
                                                header: "Actions",
                                                cell: item => (
                                                    <Button
                                                        variant="icon"
                                                        iconName="close"
                                                        onClick={() => removeEvaluator(item.id)}
                                                    />
                                                ),
                                                width: 80,
                                            },
                                        ]}
                                        items={config.evaluators}
                                        variant="embedded"
                                    />
                                )}
                            </Container>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Test Cases",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
                    <Container header={<Header variant="h2">Add Test Cases</Header>}>
                        <SpaceBetween direction="vertical" size="l">
                            <Tabs
                                activeTabId={inputMode}
                                onChange={({ detail }) => {
                                    setInputMode(detail.activeTabId as "file" | "json");
                                    // Clear test cases when switching modes
                                    setConfig(prev => ({ ...prev, testCases: [] }));
                                    setParseError("");
                                    setUploadedFiles([]);
                                    setTestCasesJson("");
                                }}
                                tabs={[
                                    {
                                        id: "file",
                                        label: "Upload File",
                                        content: (
                                            <SpaceBetween direction="vertical" size="l">
                                                <FormField
                                                    label="Test Cases JSON File"
                                                    description="Upload a JSON file containing test cases"
                                                    errorText={inputMode === "file" ? (parseError || (config.testCases.length === 0 ? "At least one test case is required" : "")) : ""}
                                                >
                                                    <FileUpload
                                                        onChange={({ detail }) => handleFileUpload(detail.value)}
                                                        value={uploadedFiles}
                                                        i18nStrings={{
                                                            uploadButtonText: () => "Choose file",
                                                            dropzoneText: () => "Drop JSON file here",
                                                            removeFileAriaLabel: () => "Remove file",
                                                            limitShowFewer: "Show fewer files",
                                                            limitShowMore: "Show more files",
                                                            errorIconAriaLabel: "Error",
                                                        }}
                                                        accept=".json"
                                                        constraintText="JSON file only"
                                                    />
                                                </FormField>
                                            </SpaceBetween>
                                        ),
                                    },
                                    {
                                        id: "json",
                                        label: "Enter JSON",
                                        content: (
                                            <SpaceBetween direction="vertical" size="l">
                                                <FormField
                                                    label="Test Cases JSON"
                                                    description="Enter test cases as a JSON array"
                                                    errorText={inputMode === "json" ? (parseError || (config.testCases.length === 0 && testCasesJson.trim() !== "" ? "Invalid JSON format" : (config.testCases.length === 0 ? "At least one test case is required" : ""))) : ""}
                                                >
                                                    <Textarea
                                                        value={testCasesJson}
                                                        onChange={({ detail }) => handleJsonInput(detail.value)}
                                                        placeholder={`[
  {
    "name": "knowledge-1",
    "input": "What is the capital of France?",
    "expected_output": "The capital of France is Paris.",
    "metadata": { "category": "knowledge" }
  },
  {
    "name": "time-1",
    "input": "What time is it right now?",
    "metadata": { "category": "time", "expected_tool": ["get_current_time"]}
  },
]`}
                                                        rows={12}
                                                    />
                                                </FormField>
                                            </SpaceBetween>
                                        ),
                                    },
                                ]}
                            />

                            <Alert type="info" header="Test Case Format">
                                Each test case must have: <strong>name</strong> and <strong>input</strong>. The fields <strong>expected_output</strong> and <strong>metadata</strong> are optional.
                                <pre style={{ margin: "8px 0 0 0", fontSize: "12px" }}>
{`[
  {
    "name": "knowledge-1",
    "input": "What is the capital of France?",
    "expected_output": "The capital of France is Paris.",
    "metadata": { "category": "knowledge" }
  },
  {
    "name": "time-1",
    "input": "What time is it right now?",
    "metadata": { "category": "time", "expected_tool": ["get_current_time"]}
  }
]`}
                                </pre>
                            </Alert>

                            {config.testCases.length > 0 && (
                                <Container header={<Header variant="h3">Parsed Test Cases ({config.testCases.length})</Header>}>
                                    <Table
                                        items={config.testCases.slice(0, 10)}
                                        columnDefinitions={[
                                            {
                                                id: "name",
                                                header: "Name",
                                                cell: item => item.name,
                                                width: 150,
                                            },
                                            {
                                                id: "input",
                                                header: "Input",
                                                cell: item => (
                                                    <span title={item.input}>
                                                        {item.input.length > 50 ? `${item.input.substring(0, 50)}...` : item.input}
                                                    </span>
                                                ),
                                            },
                                            {
                                                id: "expected_output",
                                                header: "Expected Output",
                                                cell: item => (
                                                    <span title={item.expected_output}>
                                                        {item.expected_output.length > 50 ? `${item.expected_output.substring(0, 50)}...` : item.expected_output}
                                                    </span>
                                                ),
                                            },
                                        ]}
                                        variant="embedded"
                                    />
                                    {config.testCases.length > 10 && (
                                        <Box padding="s" textAlign="center" color="text-body-secondary">
                                            Showing 10 of {config.testCases.length} test cases
                                        </Box>
                                    )}
                                </Container>
                            )}
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        {
            title: "Review",
            content: (
                <div style={{ minHeight: stepMinHeight }}>
                    <Container header={<Header variant="h2">Review Configuration</Header>}>
                        <SpaceBetween direction="vertical" size="m">
                            <Alert type="info" header="Configuration Summary">
                                Review your evaluator configuration before creating.
                            </Alert>

                            <Container header={<Header variant="h3">Basic Details</Header>}>
                                <SpaceBetween direction="vertical" size="xs">
                                    <Box><strong>Name:</strong> {config.name}</Box>
                                    <Box><strong>Description:</strong> {config.description || "N/A"}</Box>
                                    <Box><strong>Evaluation Model:</strong> {modelOptions.find(opt => opt.value === config.modelId)?.label || config.modelId}</Box>
                                    <Box><strong>Pass Threshold:</strong> {(config.passThreshold * 100).toFixed(0)}%</Box>
                                </SpaceBetween>
                            </Container>

                            <Container header={<Header variant="h3">Agent Configuration</Header>}>
                                <SpaceBetween direction="vertical" size="xs">
                                    <Box><strong>Agent Runtime:</strong> {config.agentRuntimeName}</Box>
                                    <Box><strong>Endpoint:</strong> {config.qualifier}</Box>
                                </SpaceBetween>
                            </Container>

                            <Container header={<Header variant="h3">Evaluators ({config.evaluators.length})</Header>}>
                                <SpaceBetween direction="vertical" size="xs">
                                    {config.evaluators.map((evaluator, index) => (
                                        <Box key={evaluator.id}>
                                            <strong>{index + 1}.</strong> {getEvaluatorLabel(evaluator.type)}
                                            {evaluator.rubric && (
                                                <span style={{ color: "#666", marginLeft: "8px" }}>(custom rubric)</span>
                                            )}
                                        </Box>
                                    ))}
                                </SpaceBetween>
                            </Container>

                            <Container header={<Header variant="h3">Test Cases</Header>}>
                                <Box><strong>Total Test Cases:</strong> {config.testCases.length}</Box>
                            </Container>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
    ];

    return (
        <>
            <Wizard
                i18nStrings={{
                    stepNumberLabel: stepNumber => `Step ${stepNumber}`,
                    collapsedStepsLabel: (stepNumber, stepsCount) => `Step ${stepNumber} of ${stepsCount}`,
                    navigationAriaLabel: "Steps",
                    cancelButton: "Cancel",
                    previousButton: "Previous",
                    nextButton: "Next",
                    submitButton: isCreating ? "Creating..." : "Create Evaluator",
                }}
                onNavigate={({ detail }) => setActiveStepIndex(detail.requestedStepIndex)}
                activeStepIndex={activeStepIndex}
                onCancel={onCancel}
                onSubmit={() => {
                    // Set legacy fields for backward compatibility
                    const finalConfig = {
                        ...config,
                        evaluatorType: config.evaluators[0]?.type || EvaluatorType.OUTPUT,
                        customRubric: config.evaluators[0]?.rubric || "",
                    };
                    onSubmit(finalConfig);
                }}
                steps={steps}
                isLoadingNextStep={!isStepValid(activeStepIndex) || isCreating}
            />

            {/* Configure Evaluator Modal */}
            {configModalVisible && selectedEvaluatorId && (
                <div style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: "rgba(0, 0, 0, 0.5)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 1000,
                }}>
                    <Container
                        header={
                            <Header
                                variant="h2"
                                actions={
                                    <SpaceBetween direction="horizontal" size="xs">
                                        <Button variant="link" onClick={() => setConfigModalVisible(false)}>
                                            Cancel
                                        </Button>
                                        <Button variant="primary" onClick={saveEvaluatorConfig}>
                                            Save
                                        </Button>
                                    </SpaceBetween>
                                }
                            >
                                Configure Evaluator Rubric
                            </Header>
                        }
                    >
                        <SpaceBetween direction="vertical" size="l">
                            <FormField
                                label="Custom Rubric"
                                description="Define the evaluation criteria for this evaluator"
                            >
                                <Textarea
                                    value={tempRubric}
                                    onChange={({ detail }) => setTempRubric(detail.value)}
                                    rows={12}
                                    placeholder="Enter your custom evaluation rubric..."
                                />
                            </FormField>
                            <Alert type="info">
                                The rubric defines how the evaluator should score responses.
                                Include clear criteria and scoring guidelines (1.0 = excellent, 0.5 = acceptable, 0.0 = poor).
                            </Alert>
                        </SpaceBetween>
                    </Container>
                </div>
            )}
        </>
    );
}
