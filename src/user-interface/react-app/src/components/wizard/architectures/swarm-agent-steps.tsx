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
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import { AgentCoreRuntimeConfiguration, SwarmConfiguration } from "../types";
import { CONVERSATION_MANAGER_OPTIONS, STEP_MIN_HEIGHT } from "../wizard-utils";

interface SwarmAgentStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    swarmConfig: SwarmConfiguration;
    setSwarmConfig: React.Dispatch<React.SetStateAction<SwarmConfiguration>>;
    availableAgents: RuntimeSummary[];
    isCreating: boolean;
    architectureType: string;
    addAgentReference: (agentName: string) => void;
    removeAgentReference: (index: number) => void;
    updateAgentReferenceEndpoint: (index: number, endpointName: string) => void;
    getSwarmAgentNames: () => string[];
}

export function getSwarmAgentSteps({
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
}: SwarmAgentStepsProps) {
    return [
        {
            title: "Swarm Configuration",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <Container header={<Header variant="h2">Agent Name</Header>}>
                            <FormField
                                label="Agent Name"
                                description="Enter a unique name for your swarm agent"
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

                        <Container header={<Header variant="h2">Agent Source</Header>}>
                            <SpaceBetween direction="vertical" size="l">
                                <SpaceBetween direction="vertical" size="m">
                                    <FormField label="Select Agent">
                                        <Select
                                            placeholder="Select an existing agent to reference"
                                            options={availableAgents
                                                .filter(
                                                    (a) =>
                                                        a.agentName !== config.agentName &&
                                                        !swarmConfig.agentReferences.some(
                                                            (r) =>
                                                                r.agentName === a.agentName,
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
                                                        const idx =
                                                            swarmConfig.agentReferences.findIndex(
                                                                (r) => r.agentName === item.agentName,
                                                            );
                                                        const agent = availableAgents.find(
                                                            (a) =>
                                                                a.agentName ===
                                                                item.agentName,
                                                        );
                                                        const endpointOptions: {
                                                            label: string;
                                                            value: string;
                                                        }[] = [];
                                                        if (agent?.qualifierToVersion) {
                                                            try {
                                                                const qtv = JSON.parse(
                                                                    agent.qualifierToVersion,
                                                                );
                                                                if (
                                                                    qtv &&
                                                                    typeof qtv === "object"
                                                                ) {
                                                                    endpointOptions.push(
                                                                        ...Object.keys(
                                                                            qtv,
                                                                        ).map((key) => ({
                                                                            label: key,
                                                                            value: key,
                                                                        })),
                                                                    );
                                                                }
                                                            } catch (error) {
                                                                console.error(
                                                                    "Failed to parse qualifierToVersion:",
                                                                    error,
                                                                );
                                                            }
                                                        }
                                                        if (
                                                            !endpointOptions.some(
                                                                (o) =>
                                                                    o.value === "DEFAULT",
                                                            )
                                                        ) {
                                                            endpointOptions.unshift({
                                                                label: "DEFAULT",
                                                                value: "DEFAULT",
                                                            });
                                                        }
                                                        return (
                                                            <Select
                                                                expandToViewport
                                                                selectedOption={
                                                                    endpointOptions.find(
                                                                        (o) =>
                                                                            o.value ===
                                                                            item.endpointName,
                                                                    ) || {
                                                                        label: item.endpointName,
                                                                        value: item.endpointName,
                                                                    }
                                                                }
                                                                onChange={({ detail }) =>
                                                                    updateAgentReferenceEndpoint(
                                                                        idx,
                                                                        detail.selectedOption
                                                                            ?.value ||
                                                                            "DEFAULT",
                                                                    )
                                                                }
                                                                options={endpointOptions}
                                                            />
                                                        );
                                                    },
                                                },
                                                {
                                                    id: "actions",
                                                    header: "Actions",
                                                    cell: (item) => {
                                                        const idx =
                                                            swarmConfig.agentReferences.findIndex(
                                                                (r) => r.agentName === item.agentName,
                                                            );
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

                        <Container header={<Header variant="h2">Entry Agent</Header>}>
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
                                            entryAgent: detail.selectedOption?.value || "",
                                        }))
                                    }
                                    disabled={getSwarmAgentNames().length === 0}
                                />
                            </FormField>
                        </Container>

                        <Container
                            header={<Header variant="h2">Orchestrator Settings</Header>}
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
                                                    maxHandoffs: parseInt(detail.value) || 15,
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
                                                    maxIterations: parseInt(detail.value) || 50,
                                                },
                                            }))
                                        }
                                    />
                                </FormField>
                                <FormField
                                    label="Execution Timeout (s)"
                                    description="Total execution timeout in seconds"
                                    errorText={
                                        swarmConfig.orchestrator.executionTimeoutSeconds <= 0
                                            ? "Must be greater than 0"
                                            : ""
                                    }
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
                                    errorText={
                                        swarmConfig.orchestrator.nodeTimeoutSeconds >
                                        swarmConfig.orchestrator.executionTimeoutSeconds
                                            ? "Node timeout must not exceed execution timeout"
                                            : ""
                                    }
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
                            header={<Header variant="h2">Conversation Manager</Header>}
                        >
                            <FormField label="Conversation Manager">
                                <Select
                                    selectedOption={
                                        CONVERSATION_MANAGER_OPTIONS.find(
                                            (opt) =>
                                                opt.value === swarmConfig.conversationManager,
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
                                    options={CONVERSATION_MANAGER_OPTIONS}
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
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container header={<Header variant="h2">Review Configuration</Header>}>
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
    ];
}

/** Validate a swarm step */
export function isSwarmStepValid(
    stepIndex: number,
    config: AgentCoreRuntimeConfiguration,
    swarmConfig: SwarmConfiguration,
): boolean {
    // stepIndex 0 = Swarm Configuration
    if (stepIndex === 0) {
        const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
        const hasAgentName =
            config.agentName.trim() !== "" && agentNamePattern.test(config.agentName);
        const hasAgents = swarmConfig.agentReferences.length > 0;
        const hasEntryAgent = swarmConfig.entryAgent.trim() !== "";
        const validTimeouts =
            swarmConfig.orchestrator.executionTimeoutSeconds > 0 &&
            swarmConfig.orchestrator.nodeTimeoutSeconds > 0 &&
            swarmConfig.orchestrator.nodeTimeoutSeconds <=
            swarmConfig.orchestrator.executionTimeoutSeconds;
        return hasAgentName && hasAgents && hasEntryAgent && validTimeouts;
    }
    return true;
}
