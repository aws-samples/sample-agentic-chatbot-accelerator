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
    Input,
    Modal,
    Select,
    Slider,
    SpaceBetween,
    Textarea,
    Wizard,
} from "@cloudscape-design/components";
import { useState } from "react";
import { KnowledgeBaseCreationData } from "./types";

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

interface KnowledgeBaseCreationWizardProps {
    onSubmit: (config: KnowledgeBaseCreationData) => void;
    onCancel: () => void;
    initialData?: Partial<KnowledgeBaseCreationData>;
}

export default function KnowledgeBaseCreationWizard({
    onSubmit,
    onCancel,
    initialData,
}: KnowledgeBaseCreationWizardProps) {
    const [activeStepIndex, setActiveStepIndex] = useState(0);
    const [config, setConfig] = useState<KnowledgeBaseCreationData>({
        name: initialData?.name || "",
        description: initialData?.description || "",
        model: {
            id: initialData?.model?.id || "amazon.titan-embed-text-v2:0",
            precision: initialData?.model?.precision || "FLOAT",
            vectorSize: initialData?.model?.vectorSize || 512,
        },
        dataSources: initialData?.dataSources || [
            {
                id: "",
                inputPrefix: "inputs",
                dataSourcePrefix: "knowledge-base-data-source",
                description: "",
                chunkingProps: {
                    type: "SEMANTIC",
                    semanticChunkingProps: {
                        bufferSize: 1,
                        breakpointPercentileThreshold: 75,
                        maxTokens: 512,
                    },
                },
            },
        ],
    });

    const modelOptions = [
        { label: "Titan Text Embeddings v2", value: "amazon.titan-embed-text-v2:0" },
        { label: "Titan Text Embeddings v1", value: "amazon.titan-embed-text-v1" },
    ];

    const chunkingTypeOptions = [
        { label: "Semantic", value: "SEMANTIC" },
        { label: "Fixed Size", value: "FIXED_SIZE" },
        { label: "Hierarchical", value: "HIERARCHICAL" },
        { label: "None", value: "NONE" },
    ];

    const updateConfig = (path: string, value: any) => {
        setConfig((prev) => {
            return safeDeepSet(prev, path, value);
        });
    };

    const updateDataSource = (index: number, field: string, value: any) => {
        const newDataSources = [...config.dataSources];

        // Update the data source at the specified index using safeDeepSet
        const currentDataSource = newDataSources[index];
        const updatedDataSource = safeDeepSet(currentDataSource, field, value);

        // safeDeepSet always creates a new object on success via spread operator.
        // Same reference means validation failed (dangerous key detected).
        if (updatedDataSource === currentDataSource) {
            return;
        }

        newDataSources[index] = updatedDataSource;

        // Clear other chunking props when type changes
        if (field === "chunkingProps.type") {
            delete newDataSources[index].chunkingProps.semanticChunkingProps;
            delete newDataSources[index].chunkingProps.fixedChunkingProps;
            delete newDataSources[index].chunkingProps.hierarchicalChunkingProps;

            if (value === "SEMANTIC") {
                newDataSources[index].chunkingProps.semanticChunkingProps = {
                    bufferSize: 1,
                    breakpointPercentileThreshold: 75,
                    maxTokens: 512,
                };
            } else if (value === "FIXED_SIZE") {
                newDataSources[index].chunkingProps.fixedChunkingProps = {
                    maxTokens: 512,
                    overlapPercentage: 20,
                };
            } else if (value === "HIERARCHICAL") {
                newDataSources[index].chunkingProps.hierarchicalChunkingProps = {
                    overlapTokens: 60,
                    maxParentTokenSize: 1536,
                    maxChildTokenSize: 300,
                };
            }
        }

        setConfig({ ...config, dataSources: newDataSources });
    };

    const addDataSource = () => {
        setConfig({
            ...config,
            dataSources: [
                ...config.dataSources,
                {
                    id: "",
                    inputPrefix: "inputs",
                    dataSourcePrefix: "knowledge-base-data-source",
                    description: "",
                    chunkingProps: {
                        type: "SEMANTIC",
                        semanticChunkingProps: {
                            bufferSize: 1,
                            breakpointPercentileThreshold: 75,
                            maxTokens: 512,
                        },
                    },
                },
            ],
        });
    };

    const removeDataSource = (index: number) => {
        if (config.dataSources.length > 1) {
            const newDataSources = [...config.dataSources];
            newDataSources.splice(index, 1);
            setConfig({ ...config, dataSources: newDataSources });
        }
    };

    const renderChunkingConfig = (ds: any, index: number) => {
        switch (ds.chunkingProps.type) {
            case "SEMANTIC":
                return (
                    <>
                        <FormField label="Max Tokens">
                            <Slider
                                value={ds.chunkingProps.semanticChunkingProps?.maxTokens || 512}
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.semanticChunkingProps.maxTokens",
                                        detail.value,
                                    )
                                }
                                min={100}
                                max={2000}
                                step={50}
                            />
                        </FormField>
                        <FormField label="Breakpoint Threshold">
                            <Slider
                                value={
                                    ds.chunkingProps.semanticChunkingProps
                                        ?.breakpointPercentileThreshold || 75
                                }
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.semanticChunkingProps.breakpointPercentileThreshold",
                                        detail.value,
                                    )
                                }
                                min={50}
                                max={95}
                                step={5}
                            />
                        </FormField>
                        <FormField label="Buffer Size">
                            <Slider
                                value={ds.chunkingProps.semanticChunkingProps?.bufferSize || 1}
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.semanticChunkingProps.bufferSize",
                                        detail.value,
                                    )
                                }
                                min={0}
                                max={5}
                                step={1}
                            />
                        </FormField>
                    </>
                );
            case "FIXED_SIZE":
                return (
                    <>
                        <FormField label="Max Tokens">
                            <Slider
                                value={ds.chunkingProps.fixedChunkingProps?.maxTokens || 512}
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.fixedChunkingProps.maxTokens",
                                        detail.value,
                                    )
                                }
                                min={100}
                                max={2000}
                                step={50}
                            />
                        </FormField>
                        <FormField label="Overlap Percentage">
                            <Slider
                                value={ds.chunkingProps.fixedChunkingProps?.overlapPercentage || 20}
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.fixedChunkingProps.overlapPercentage",
                                        detail.value,
                                    )
                                }
                                min={0}
                                max={50}
                                step={5}
                            />
                        </FormField>
                    </>
                );
            case "HIERARCHICAL":
                return (
                    <>
                        <FormField label="Max Parent Token Size">
                            <Slider
                                value={
                                    ds.chunkingProps.hierarchicalChunkingProps
                                        ?.maxParentTokenSize || 1536
                                }
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.hierarchicalChunkingProps.maxParentTokenSize",
                                        detail.value,
                                    )
                                }
                                min={500}
                                max={3000}
                                step={100}
                            />
                        </FormField>
                        <FormField label="Max Child Token Size">
                            <Slider
                                value={
                                    ds.chunkingProps.hierarchicalChunkingProps?.maxChildTokenSize ||
                                    300
                                }
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.hierarchicalChunkingProps.maxChildTokenSize",
                                        detail.value,
                                    )
                                }
                                min={100}
                                max={1000}
                                step={50}
                            />
                        </FormField>
                        <FormField label="Overlap Tokens">
                            <Slider
                                value={
                                    ds.chunkingProps.hierarchicalChunkingProps?.overlapTokens || 60
                                }
                                onChange={({ detail }) =>
                                    updateDataSource(
                                        index,
                                        "chunkingProps.hierarchicalChunkingProps.overlapTokens",
                                        detail.value,
                                    )
                                }
                                min={0}
                                max={200}
                                step={10}
                            />
                        </FormField>
                    </>
                );
            default:
                return null;
        }
    };

    const steps = [
        {
            title: "Basic Configuration",
            content: (
                <Container header={<Header variant="h2">Knowledge Base Settings</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        <FormField
                            label="Name"
                            errorText={
                                config.name.includes(" ")
                                    ? "Knowledge Base name cannot contain spaces"
                                    : config.name.trim() === ""
                                      ? "Knowledge Base name is required"
                                      : ""
                            }
                        >
                            <Textarea
                                value={config.name}
                                onChange={({ detail }) => updateConfig("name", detail.value)}
                                placeholder="Enter knowledge base name"
                                rows={1}
                                invalid={config.name.trim() === "" || config.name.includes(" ")}
                            />
                        </FormField>
                        <FormField label="Description">
                            <Textarea
                                value={config.description}
                                onChange={({ detail }) => updateConfig("description", detail.value)}
                                placeholder="Enter knowledge base description"
                                rows={3}
                            />
                        </FormField>
                        <FormField label="Embedding Model">
                            <Select
                                selectedOption={
                                    modelOptions.find((opt) => opt.value === config.model.id) ||
                                    null
                                }
                                onChange={({ detail }) =>
                                    updateConfig("model.id", detail.selectedOption?.value || "")
                                }
                                options={modelOptions}
                            />
                        </FormField>
                        <FormField label="Vector Size">
                            <Slider
                                value={config.model.vectorSize}
                                onChange={({ detail }) =>
                                    updateConfig("model.vectorSize", detail.value)
                                }
                                min={256}
                                max={1536}
                                step={256}
                            />
                        </FormField>
                    </SpaceBetween>
                </Container>
            ),
        },
        {
            title: "Data Sources",
            content: (
                <Container header={<Header variant="h2">Configure Data Sources</Header>}>
                    <SpaceBetween direction="vertical" size="l">
                        {config.dataSources.map((ds, index) => (
                            <Container
                                key={index}
                                header={<Header variant="h3">Data Source {index + 1}</Header>}
                            >
                                <SpaceBetween direction="vertical" size="m">
                                    <FormField
                                        label="Data Source ID"
                                        errorText={
                                            ds.id.includes(" ")
                                                ? "Data Source name cannot contain spaces"
                                                : ds.id.trim() === ""
                                                  ? "Data Source Base name is required"
                                                  : ""
                                        }
                                    >
                                        <Input
                                            value={ds.id}
                                            onChange={({ detail }) =>
                                                updateDataSource(index, "id", detail.value)
                                            }
                                            invalid={ds.id.includes(" ") || ds.id.trim() === ""}
                                        />
                                    </FormField>
                                    <FormField label="Description">
                                        <Input
                                            value={ds.description}
                                            onChange={({ detail }) =>
                                                updateDataSource(index, "description", detail.value)
                                            }
                                        />
                                    </FormField>
                                    <FormField label="Chunking Type">
                                        <Select
                                            selectedOption={
                                                chunkingTypeOptions.find(
                                                    (opt) => opt.value === ds.chunkingProps.type,
                                                ) || null
                                            }
                                            onChange={({ detail }) =>
                                                updateDataSource(
                                                    index,
                                                    "chunkingProps.type",
                                                    detail.selectedOption?.value,
                                                )
                                            }
                                            options={chunkingTypeOptions}
                                        />
                                    </FormField>
                                    {renderChunkingConfig(ds, index)}
                                    {config.dataSources.length > 1 && (
                                        <Button
                                            onClick={() => removeDataSource(index)}
                                            variant="link"
                                        >
                                            Remove Data Source
                                        </Button>
                                    )}
                                </SpaceBetween>
                            </Container>
                        ))}
                        <Button onClick={addDataSource} variant="link">
                            Add Data Source
                        </Button>
                    </SpaceBetween>
                </Container>
            ),
        },
        {
            title: "Review",
            content: (
                <Container header={<Header variant="h2">Review Configuration</Header>}>
                    <SpaceBetween direction="vertical" size="m">
                        <Alert type="info" header="Configuration Summary">
                            Review your settings before creating the knowledge base.
                        </Alert>
                        <Box padding="m" variant="code">
                            <pre style={{ margin: 0, overflow: "auto" }}>
                                {JSON.stringify(config, null, 2)}
                            </pre>
                        </Box>
                    </SpaceBetween>
                </Container>
            ),
        },
    ];

    const isStepValid = (stepIndex: number) => {
        if (stepIndex === 0) {
            return config.name.trim() !== "" && !config.name.includes(" ");
        }
        if (stepIndex === 1) {
            return config.dataSources.every((ds) => ds.id.trim() !== "" && !ds.id.includes(" "));
        }
        return true;
    };

    return (
        <Modal visible={true} onDismiss={onCancel} header="Create Knowledge Base" size="max">
            <Wizard
                i18nStrings={{
                    stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
                    collapsedStepsLabel: (stepNumber, stepsCount) =>
                        `Step ${stepNumber} of ${stepsCount}`,
                    navigationAriaLabel: "Steps",
                    cancelButton: "Cancel",
                    previousButton: "Previous",
                    nextButton: "Next",
                    submitButton: "Create Knowledge Base",
                }}
                onNavigate={({ detail }) => setActiveStepIndex(detail.requestedStepIndex)}
                activeStepIndex={activeStepIndex}
                onCancel={onCancel}
                onSubmit={() => onSubmit(config)}
                steps={steps.map((step, _) => ({
                    title: step.title,
                    content: step.content,
                }))}
                isLoadingNextStep={!isStepValid(activeStepIndex)}
            />
        </Modal>
    );
}
