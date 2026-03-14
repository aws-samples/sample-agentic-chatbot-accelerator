// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    ColumnLayout,
    Container,
    FormField,
    Header,
    Input,
    SpaceBetween,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import { AgentCoreRuntimeConfiguration, GraphConfiguration } from "../types";
import { STEP_MIN_HEIGHT } from "../wizard-utils";
import GraphDesigner from "./graph-designer";

export interface GraphAgentStepsProps {
    config: AgentCoreRuntimeConfiguration;
    setConfig: React.Dispatch<React.SetStateAction<AgentCoreRuntimeConfiguration>>;
    graphConfig: GraphConfiguration;
    setGraphConfig: React.Dispatch<React.SetStateAction<GraphConfiguration>>;
    availableAgents: RuntimeSummary[];
    isCreating: boolean;
}

export function getGraphAgentSteps({
    config,
    setConfig,
    graphConfig,
    setGraphConfig,
    availableAgents,
    isCreating,
}: GraphAgentStepsProps) {
    // Build a simple visual minimap of the graph for the review step
    const renderMinimap = () => {
        if (graphConfig.nodes.length === 0) {
            return <Box color="text-status-inactive">No nodes to display.</Box>;
        }

        const nodeMap = new Map(
            graphConfig.nodes.map((n) => [n.id, n.label || n.id]),
        );

        return (
            <div
                style={{
                    padding: "16px",
                    background: "#fafafa",
                    borderRadius: "8px",
                    border: "1px solid #eaeded",
                    fontFamily: "monospace",
                    fontSize: "13px",
                    lineHeight: "1.8",
                    overflow: "auto",
                }}
            >
                <div style={{ marginBottom: "8px", fontWeight: "bold" }}>
                    Entry: [{graphConfig.entryPoint}]
                </div>
                {graphConfig.edges.map((edge, i) => (
                    <div key={i} style={{ paddingLeft: "8px" }}>
                        [{nodeMap.get(edge.source) || edge.source}]
                        {edge.condition ? " - - → " : " ———→ "}
                        [{edge.target === "__end__"
                            ? "END"
                            : nodeMap.get(edge.target) || edge.target}]
                        {edge.condition && (
                            <span style={{ color: "#687078" }}>
                                {" "}
                                if: {edge.condition}
                            </span>
                        )}
                    </div>
                ))}
                {graphConfig.edges.length === 0 && (
                    <div style={{ color: "#687078" }}>No edges defined.</div>
                )}
            </div>
        );
    };

    return [
        // Step 1: Graph Design
        {
            title: "Graph Design",
            content: (
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        <Container
                            header={<Header variant="h2">Agent Name</Header>}
                        >
                            <FormField
                                label="Agent Name"
                                description="Enter a unique name for your graph agent"
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

                        <GraphDesigner
                            graphConfig={graphConfig}
                            setGraphConfig={setGraphConfig}
                            availableAgents={availableAgents}
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
                                <FormField
                                    label="Max Iterations"
                                    description="Maximum total iterations (recursion limit)"
                                >
                                    <Input
                                        type="number"
                                        value={graphConfig.orchestrator.maxIterations.toString()}
                                        onChange={({ detail }) =>
                                            setGraphConfig((prev) => ({
                                                ...prev,
                                                orchestrator: {
                                                    ...prev.orchestrator,
                                                    maxIterations:
                                                        parseInt(
                                                            detail.value,
                                                        ) || 50,
                                                },
                                            }))
                                        }
                                    />
                                </FormField>
                                <FormField
                                    label="Execution Timeout (s)"
                                    description="Total execution timeout in seconds"
                                    errorText={
                                        graphConfig.orchestrator
                                            .executionTimeoutSeconds <= 0
                                            ? "Must be greater than 0"
                                            : ""
                                    }
                                >
                                    <Input
                                        type="number"
                                        value={graphConfig.orchestrator.executionTimeoutSeconds.toString()}
                                        onChange={({ detail }) =>
                                            setGraphConfig((prev) => ({
                                                ...prev,
                                                orchestrator: {
                                                    ...prev.orchestrator,
                                                    executionTimeoutSeconds:
                                                        parseFloat(
                                                            detail.value,
                                                        ) || 300,
                                                },
                                            }))
                                        }
                                    />
                                </FormField>
                                <FormField
                                    label="Node Timeout (s)"
                                    description="Per-node timeout in seconds"
                                    errorText={
                                        graphConfig.orchestrator
                                            .nodeTimeoutSeconds >
                                        graphConfig.orchestrator
                                            .executionTimeoutSeconds
                                            ? "Node timeout must not exceed execution timeout"
                                            : graphConfig.orchestrator
                                                    .nodeTimeoutSeconds <= 0
                                              ? "Must be greater than 0"
                                              : ""
                                    }
                                >
                                    <Input
                                        type="number"
                                        value={graphConfig.orchestrator.nodeTimeoutSeconds.toString()}
                                        onChange={({ detail }) =>
                                            setGraphConfig((prev) => ({
                                                ...prev,
                                                orchestrator: {
                                                    ...prev.orchestrator,
                                                    nodeTimeoutSeconds:
                                                        parseFloat(
                                                            detail.value,
                                                        ) || 60,
                                                },
                                            }))
                                        }
                                    />
                                </FormField>
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
                <div style={{ minHeight: STEP_MIN_HEIGHT }}>
                    <SpaceBetween direction="vertical" size="l">
                        {!isCreating && (
                            <Alert type="info" header="Configuration Summary">
                                Review your graph agent configuration before
                                creating.
                            </Alert>
                        )}

                        <Container
                            header={<Header variant="h2">Graph Minimap</Header>}
                        >
                            {renderMinimap()}
                        </Container>

                        <Container
                            header={
                                <Header variant="h2">
                                    Configuration JSON
                                </Header>
                            }
                        >
                            <Box padding="m" variant="code">
                                <pre
                                    style={{
                                        margin: 0,
                                        overflow: "auto",
                                        maxHeight: "400px",
                                    }}
                                >
                                    {JSON.stringify(
                                        {
                                            agentName: config.agentName,
                                            architectureType: "GRAPH",
                                            graphConfig,
                                        },
                                        null,
                                        2,
                                    )}
                                </pre>
                            </Box>
                        </Container>
                    </SpaceBetween>
                </div>
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
    const agentNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

    // Step 0: Graph Design
    if (stepIndex === 0) {
        const hasAgentName =
            config.agentName.trim() !== "" &&
            agentNamePattern.test(config.agentName);
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
            orchestrator.maxIterations >= 1 &&
            orchestrator.executionTimeoutSeconds > 0 &&
            orchestrator.nodeTimeoutSeconds > 0 &&
            orchestrator.nodeTimeoutSeconds <=
                orchestrator.executionTimeoutSeconds
        );
    }

    // Step 2: Review — always valid
    return true;
}
