// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
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
import {
    AGENT_NAME_MAX_LENGTH,
    CONVERSATION_MANAGER_OPTIONS,
    DEFAULT_MAX_HANDOFFS,
    orchestratorTimeoutsValid,
    STEP_MIN_HEIGHT,
    agentNameError,
} from "../wizard-utils";
import ReviewStep from "./review-step";
import { getEndpointOptions } from "../../../common/utils";
import { AgentNameField, OrchestratorLimitFields } from "../wizard-shared-components";

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
                        <AgentNameField
                            value={config.agentName}
                            onChange={(agentName) => setConfig((prev) => ({ ...prev, agentName }))}
                            description="Enter a unique name for your swarm agent"
                            maxLength={AGENT_NAME_MAX_LENGTH}
                        />

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
                                                        const endpointOptions =
                                                            getEndpointOptions(agent);
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
                                                    maxHandoffs: parseInt(detail.value) || DEFAULT_MAX_HANDOFFS,
                                                },
                                            }))
                                        }
                                    />
                                </FormField>
                                <OrchestratorLimitFields
                                    orchestrator={swarmConfig.orchestrator}
                                    onChange={(patch) =>
                                        setSwarmConfig((prev) => ({
                                            ...prev,
                                            orchestrator: { ...prev.orchestrator, ...patch },
                                        }))
                                    }
                                    maxIterationsDescription="Maximum total iterations"
                                    nodeTimeoutDescription="Per-agent timeout in seconds"
                                />
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
                <ReviewStep
                    // Flatten to the shape AgentConfigView's swarm guard expects
                    // (entryAgent + agents/agentReferences at the top level).
                    config={
                        {
                            agentName: config.agentName,
                            architectureType,
                            ...swarmConfig,
                        } as unknown as AgentCoreRuntimeConfiguration
                    }
                    // Raw JSON mirrors the saved (nested) submission shape.
                    rawForJson={{
                        agentName: config.agentName,
                        architectureType,
                        swarmConfig,
                    }}
                    summary="Review your swarm agent configuration before creating."
                    isCreating={isCreating}
                />
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
        const hasAgentName =
            agentNameError(config.agentName, AGENT_NAME_MAX_LENGTH) === "";
        const hasAgents = swarmConfig.agentReferences.length > 0;
        const hasEntryAgent = swarmConfig.entryAgent.trim() !== "";
        const validTimeouts = orchestratorTimeoutsValid(swarmConfig.orchestrator);
        return hasAgentName && hasAgents && hasEntryAgent && validTimeouts;
    }
    return true;
}
