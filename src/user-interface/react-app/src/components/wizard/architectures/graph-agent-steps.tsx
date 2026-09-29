// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    ColumnLayout,
    Container,
    Header,
    SpaceBetween,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import {
    AgentCoreRuntimeConfiguration,
    GraphConfiguration,
    PredefinedDeterministicNode,
    PredefinedStateClass,
} from "../types";
import {
    AGENT_NAME_MAX_LENGTH,
    STEP_MIN_HEIGHT,
    agentNameError,
    orchestratorTimeoutsValid,
} from "../wizard-utils";
import GraphDesigner from "./graph-designer";
import ReviewStep from "./review-step";
import { AgentNameField, OrchestratorLimitFields } from "../wizard-shared-components";

export interface GraphAgentStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    graphConfig: GraphConfiguration;
    setGraphConfig: React.Dispatch<React.SetStateAction<GraphConfiguration>>;
    availableAgents: RuntimeSummary[];
    availableStateClasses?: PredefinedStateClass[];
    availableDeterministicNodes?: PredefinedDeterministicNode[];
    isCreating: boolean;
}

export function getGraphAgentSteps({
    config,
    setConfig,
    graphConfig,
    setGraphConfig,
    availableAgents,
    availableStateClasses = [],
    availableDeterministicNodes = [],
    isCreating,
}: GraphAgentStepsProps) {
    return [
        // Step 1: Graph Design
        {
            title: "Graph Design",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <AgentNameField
                            value={config.agentName}
                            onChange={(agentName) => setConfig((prev) => ({ ...prev, agentName }))}
                            description="Enter a unique name for your graph agent"
                            maxLength={AGENT_NAME_MAX_LENGTH}
                        />

                        <GraphDesigner
                            graphConfig={graphConfig}
                            setGraphConfig={setGraphConfig}
                            availableAgents={availableAgents}
                            availableStateClasses={availableStateClasses}
                            availableDeterministicNodes={availableDeterministicNodes}
                            currentAgentName={config.agentName}
                        />
                    </SpaceBetween>
                </div>
            ),
        },
        // Step 2: Orchestrator Settings
        {
            title: "Orchestrator Settings",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <Container
                        header={
                            <Header variant="h2">Orchestrator Settings</Header>
                        }
                    >
                        <SpaceBetween direction="vertical" size="l">
                            <ColumnLayout columns={2} variant="text-grid">
                                <OrchestratorLimitFields
                                    orchestrator={graphConfig.orchestrator}
                                    onChange={(patch) =>
                                        setGraphConfig((prev) => ({
                                            ...prev,
                                            orchestrator: { ...prev.orchestrator, ...patch },
                                        }))
                                    }
                                    maxIterationsDescription="Maximum total iterations (recursion limit)"
                                    nodeTimeoutDescription="Per-node timeout in seconds"
                                />
                            </ColumnLayout>
                        </SpaceBetween>
                    </Container>
                </div>
            ),
        },
        // Step 3: Review
        {
            title: "Review",
            content: (
                <ReviewStep
                    // Flatten to the shape AgentConfigView's graph guard expects
                    // (nodes + entryPoint at the top level). AgentConfigView renders
                    // its own Graph Topology minimap, so no separate minimap here.
                    config={
                        {
                            agentName: config.agentName,
                            architectureType: "GRAPH",
                            ...graphConfig,
                        } as unknown as AgentCoreRuntimeConfiguration
                    }
                    // Raw JSON mirrors the saved (nested) submission shape.
                    rawForJson={{
                        agentName: config.agentName,
                        architectureType: "GRAPH",
                        graphConfig,
                    }}
                    summary="Review your graph agent configuration before creating."
                    isCreating={isCreating}
                />
            ),
        },
    ];
}

/** Validate a graph step */
export function isGraphStepValid(
    stepIndex: number,
    config: AgentCoreRuntimeConfiguration,
    graphConfig: GraphConfiguration,
): boolean {

    // Step 0: Graph Design
    if (stepIndex === 0) {
        const hasAgentName =
            agentNameError(config.agentName, AGENT_NAME_MAX_LENGTH) === "";
        const hasNodes = graphConfig.nodes.length > 0;
        const hasEntryPoint =
            graphConfig.entryPoint.trim() !== "" &&
            graphConfig.nodes.some((n) => n.id === graphConfig.entryPoint);
        // All edge references must be valid
        const nodeIds = new Set(graphConfig.nodes.map((n) => n.id));
        nodeIds.add("__end__");
        const edgesValid = graphConfig.edges.every(
            (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
        );
        // Non-terminal nodes must have outgoing edges
        const nodesWithOutgoing = new Set(
            graphConfig.edges.map((e) => e.source),
        );
        const allNodesHaveEdges = graphConfig.nodes.every((n) =>
            nodesWithOutgoing.has(n.id),
        );
        return (
            hasAgentName &&
            hasNodes &&
            hasEntryPoint &&
            edgesValid &&
            allNodesHaveEdges
        );
    }

    // Step 1: Orchestrator Settings
    if (stepIndex === 1) {
        const { orchestrator } = graphConfig;
        return (
            orchestrator.maxIterations >= 1 && orchestratorTimeoutsValid(orchestrator)
        );
    }

    // Step 2: Review — always valid
    return true;
}
