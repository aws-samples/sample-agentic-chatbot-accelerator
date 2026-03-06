// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import React from "react";
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
    Toggle,
} from "@cloudscape-design/components";
import { RuntimeSummary } from "../../../API";
import {
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
} from "../types";

interface GraphDesignerProps {
    graphConfig: GraphConfiguration;
    setGraphConfig: React.Dispatch<React.SetStateAction<GraphConfiguration>>;
    availableAgents: RuntimeSummary[];
    currentAgentName: string;
}

export default function GraphDesigner({
    graphConfig,
    setGraphConfig,
    availableAgents,
    currentAgentName,
}: GraphDesignerProps) {
    // Filter out the current agent being created to prevent self-referencing
    const selectableAgents = availableAgents.filter(
        (a) => a.agentName !== currentAgentName,
    );

    // ----------------------------------------------------------------
    // Node management
    // ----------------------------------------------------------------
    const addNode = (agentName: string) => {
        const agent = selectableAgents.find((a) => a.agentName === agentName);
        if (!agent) return;

        const existingCount = graphConfig.nodes.filter(
            (n) => n.agentName === agentName,
        ).length;
        const nodeId = existingCount > 0
            ? `${agentName}_${existingCount + 1}`
            : agentName;

        const newNode: GraphNodeDefinition = {
            id: nodeId,
            agentName,
            endpointName: "DEFAULT",
            label: nodeId,
        };

        setGraphConfig((prev) => ({
            ...prev,
            nodes: [...prev.nodes, newNode],
        }));
    };

    const removeNode = (nodeId: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.filter((n) => n.id !== nodeId),
            edges: prev.edges.filter(
                (e) => e.source !== nodeId && e.target !== nodeId,
            ),
            entryPoint: prev.entryPoint === nodeId ? "" : prev.entryPoint,
        }));
    };

    const updateNodeEndpoint = (nodeId: string, endpointName: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) =>
                n.id === nodeId ? { ...n, endpointName } : n,
            ),
        }));
    };

    const updateNodeLabel = (nodeId: string, label: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) =>
                n.id === nodeId ? { ...n, label } : n,
            ),
        }));
    };

    // ----------------------------------------------------------------
    // Edge management
    // ----------------------------------------------------------------
    const [newEdgeSource, setNewEdgeSource] = React.useState<string>("");
    const [newEdgeTarget, setNewEdgeTarget] = React.useState<string>("");
    const [newEdgeCondition, setNewEdgeCondition] = React.useState<string>("");
    const [newEdgeIsConditional, setNewEdgeIsConditional] = React.useState(false);

    const nodeIdOptions = graphConfig.nodes.map((n) => ({
        label: n.label || n.id,
        value: n.id,
        description: n.agentName,
    }));

    const targetOptions = [
        ...nodeIdOptions,
        { label: "__end__", value: "__end__", description: "Terminal node" },
    ];

    const addEdge = () => {
        if (!newEdgeSource || !newEdgeTarget) return;
        // Prevent duplicate edges
        const exists = graphConfig.edges.some(
            (e) => e.source === newEdgeSource && e.target === newEdgeTarget,
        );
        if (exists) return;

        const edge: GraphEdgeDefinition = {
            source: newEdgeSource,
            target: newEdgeTarget,
            ...(newEdgeIsConditional && newEdgeCondition.trim()
                ? { condition: newEdgeCondition.trim() }
                : {}),
        };

        setGraphConfig((prev) => ({
            ...prev,
            edges: [...prev.edges, edge],
        }));
        setNewEdgeSource("");
        setNewEdgeTarget("");
        setNewEdgeCondition("");
        setNewEdgeIsConditional(false);
    };

    const removeEdge = (index: number) => {
        setGraphConfig((prev) => ({
            ...prev,
            edges: prev.edges.filter((_, i) => i !== index),
        }));
    };

    // ----------------------------------------------------------------
    // State schema management
    // ----------------------------------------------------------------
    const [newFieldName, setNewFieldName] = React.useState("");
    const [newFieldType, setNewFieldType] = React.useState("str");

    const stateSchemaEntries = Object.entries(graphConfig.stateSchema);

    const addSchemaField = () => {
        if (!newFieldName.trim()) return;
        if (graphConfig.stateSchema[newFieldName.trim()] !== undefined) return;
        setGraphConfig((prev) => ({
            ...prev,
            stateSchema: {
                ...prev.stateSchema,
                [newFieldName.trim()]: newFieldType,
            },
        }));
        setNewFieldName("");
        setNewFieldType("str");
    };

    const removeSchemaField = (fieldName: string) => {
        setGraphConfig((prev) => {
            const { [fieldName]: _, ...rest } = prev.stateSchema;
            return { ...prev, stateSchema: rest };
        });
    };

    // ----------------------------------------------------------------
    // Validation helpers
    // ----------------------------------------------------------------
    const getValidationErrors = (): string[] => {
        const errors: string[] = [];
        if (graphConfig.nodes.length === 0) {
            errors.push("At least one node is required.");
        }
        if (graphConfig.nodes.length > 0 && !graphConfig.entryPoint) {
            errors.push(
                "An entry point is required. Select one node as the graph entry point.",
            );
        }
        if (
            graphConfig.entryPoint &&
            !graphConfig.nodes.some((n) => n.id === graphConfig.entryPoint)
        ) {
            errors.push(
                `Entry point '${graphConfig.entryPoint}' does not match any node in the graph.`,
            );
        }
        // Check non-terminal nodes have outgoing edges
        const nodesWithOutgoing = new Set(graphConfig.edges.map((e) => e.source));
        const terminalTargets = new Set(
            graphConfig.edges
                .filter((e) => e.target === "__end__")
                .map((e) => e.source),
        );
        for (const node of graphConfig.nodes) {
            if (!nodesWithOutgoing.has(node.id) && !terminalTargets.has(node.id)) {
                errors.push(
                    `Node '${node.id}' has no outgoing edges and is not terminal.`,
                );
            }
        }
        return errors;
    };

    // Detect unconditional cycles (warning, non-blocking)
    const getWarnings = (): string[] => {
        const warnings: string[] = [];
        // Simple cycle detection on unconditional edges only
        const unconditionalEdges = graphConfig.edges.filter((e) => !e.condition);
        const adjacency: Record<string, string[]> = {};
        for (const edge of unconditionalEdges) {
            if (!adjacency[edge.source]) adjacency[edge.source] = [];
            adjacency[edge.source].push(edge.target);
        }
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const detectCycle = (nodeId: string): boolean => {
            if (inStack.has(nodeId)) return true;
            if (visited.has(nodeId)) return false;
            visited.add(nodeId);
            inStack.add(nodeId);
            for (const neighbor of adjacency[nodeId] || []) {
                if (neighbor !== "__end__" && detectCycle(neighbor)) return true;
            }
            inStack.delete(nodeId);
            return false;
        };
        for (const nodeId of Object.keys(adjacency)) {
            if (detectCycle(nodeId)) {
                warnings.push(
                    "Warning: Potential infinite loop detected. Consider adding a conditional edge to break the cycle.",
                );
                break;
            }
        }
        return warnings;
    };

    const validationErrors = getValidationErrors();
    const warnings = getWarnings();

    // Helper to get endpoint options for an agent
    const getEndpointOptions = (agentName: string) => {
        const agent = availableAgents.find((a) => a.agentName === agentName);
        const options: { label: string; value: string }[] = [];
        if (agent?.qualifierToVersion) {
            try {
                const qtv = JSON.parse(agent.qualifierToVersion);
                if (qtv && typeof qtv === "object") {
                    options.push(
                        ...Object.keys(qtv).map((key) => ({
                            label: key,
                            value: key,
                        })),
                    );
                }
            } catch {
                // ignore parse errors
            }
        }
        if (!options.some((o) => o.value === "DEFAULT")) {
            options.unshift({ label: "DEFAULT", value: "DEFAULT" });
        }
        return options;
    };

    return (
        <SpaceBetween direction="vertical" size="l">
            {/* Nodes Section */}
            <Container header={<Header variant="h2">Graph Nodes</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    <FormField
                        label="Add Node"
                        description="Select an existing agent to add as a graph node"
                    >
                        <Select
                            placeholder="Select an agent..."
                            options={selectableAgents.map((a) => ({
                                label: a.agentName,
                                value: a.agentName,
                                description: a.architectureType || undefined,
                            }))}
                            onChange={({ detail }) => {
                                if (detail.selectedOption?.value) {
                                    addNode(detail.selectedOption.value);
                                }
                            }}
                            selectedOption={null}
                            filteringType="auto"
                        />
                    </FormField>
                    {graphConfig.nodes.length === 0 ? (
                        <Alert type="info">
                            No nodes added yet. Select an agent above to add a
                            node.
                        </Alert>
                    ) : (
                        <Table
                            items={graphConfig.nodes}
                            columnDefinitions={[
                                {
                                    id: "id",
                                    header: "Node ID",
                                    cell: (item) => item.id,
                                    isRowHeader: true,
                                },
                                {
                                    id: "label",
                                    header: "Label",
                                    cell: (item) => (
                                        <Input
                                            value={item.label || ""}
                                            onChange={({ detail }) =>
                                                updateNodeLabel(
                                                    item.id,
                                                    detail.value,
                                                )
                                            }
                                            placeholder={item.id}
                                        />
                                    ),
                                },
                                {
                                    id: "agentName",
                                    header: "Agent",
                                    cell: (item) => {
                                        const agent = availableAgents.find(
                                            (a) =>
                                                a.agentName === item.agentName,
                                        );
                                        return (
                                            <SpaceBetween
                                                direction="horizontal"
                                                size="xs"
                                            >
                                                <span>{item.agentName}</span>
                                                {agent?.architectureType && (
                                                    <Box
                                                        color="text-status-info"
                                                        fontSize="body-s"
                                                    >
                                                        (
                                                        {
                                                            agent.architectureType
                                                        }
                                                        )
                                                    </Box>
                                                )}
                                            </SpaceBetween>
                                        );
                                    },
                                },
                                {
                                    id: "endpoint",
                                    header: "Endpoint",
                                    cell: (item) => {
                                        const options = getEndpointOptions(
                                            item.agentName,
                                        );
                                        return (
                                            <Select
                                                expandToViewport
                                                selectedOption={
                                                    options.find(
                                                        (o) =>
                                                            o.value ===
                                                            item.endpointName,
                                                    ) || {
                                                        label: item.endpointName,
                                                        value: item.endpointName,
                                                    }
                                                }
                                                onChange={({ detail }) =>
                                                    updateNodeEndpoint(
                                                        item.id,
                                                        detail.selectedOption
                                                            ?.value ||
                                                            "DEFAULT",
                                                    )
                                                }
                                                options={options}
                                            />
                                        );
                                    },
                                },
                                {
                                    id: "entryPoint",
                                    header: "Entry Point",
                                    cell: (item) => (
                                        <Button
                                            variant={
                                                graphConfig.entryPoint ===
                                                item.id
                                                    ? "primary"
                                                    : "normal"
                                            }
                                            onClick={() =>
                                                setGraphConfig((prev) => ({
                                                    ...prev,
                                                    entryPoint: item.id,
                                                }))
                                            }
                                        >
                                            {graphConfig.entryPoint === item.id
                                                ? "✓ Entry"
                                                : "Set"}
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
                                                removeNode(item.id)
                                            }
                                        />
                                    ),
                                },
                            ]}
                        />
                    )}
                </SpaceBetween>
            </Container>

            {/* Edges Section */}
            <Container header={<Header variant="h2">Graph Edges</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    <ColumnLayout columns={newEdgeIsConditional ? 4 : 3}>
                        <FormField label="Source Node">
                            <Select
                                placeholder="Select source..."
                                options={nodeIdOptions}
                                selectedOption={
                                    newEdgeSource
                                        ? nodeIdOptions.find(
                                              (o) =>
                                                  o.value === newEdgeSource,
                                          ) || null
                                        : null
                                }
                                onChange={({ detail }) =>
                                    setNewEdgeSource(
                                        detail.selectedOption?.value || "",
                                    )
                                }
                            />
                        </FormField>
                        <FormField label="Target Node">
                            <Select
                                placeholder="Select target..."
                                options={targetOptions}
                                selectedOption={
                                    newEdgeTarget
                                        ? targetOptions.find(
                                              (o) =>
                                                  o.value === newEdgeTarget,
                                          ) || null
                                        : null
                                }
                                onChange={({ detail }) =>
                                    setNewEdgeTarget(
                                        detail.selectedOption?.value || "",
                                    )
                                }
                            />
                        </FormField>
                        {newEdgeIsConditional && (
                            <FormField label="Condition Expression">
                                <Input
                                    value={newEdgeCondition}
                                    onChange={({ detail }) =>
                                        setNewEdgeCondition(detail.value)
                                    }
                                    placeholder="e.g. approved, rejected, done"
                                />
                            </FormField>
                        )}
                        <FormField label=" ">
                            <SpaceBetween direction="horizontal" size="xs">
                                <Toggle
                                    checked={newEdgeIsConditional}
                                    onChange={({ detail }) =>
                                        setNewEdgeIsConditional(detail.checked)
                                    }
                                >
                                    Conditional
                                </Toggle>
                                <Button
                                    onClick={addEdge}
                                    disabled={
                                        !newEdgeSource || !newEdgeTarget
                                    }
                                >
                                    Add Edge
                                </Button>
                            </SpaceBetween>
                        </FormField>
                    </ColumnLayout>
                    {graphConfig.edges.length === 0 ? (
                        <Alert type="info">
                            No edges defined yet. Add edges to connect your
                            nodes.
                        </Alert>
                    ) : (
                        <Table
                            items={graphConfig.edges.map((e, i) => ({
                                ...e,
                                _index: i,
                            }))}
                            columnDefinitions={[
                                {
                                    id: "source",
                                    header: "Source",
                                    cell: (item) => {
                                        const node = graphConfig.nodes.find(
                                            (n) => n.id === item.source,
                                        );
                                        return node?.label || item.source;
                                    },
                                    isRowHeader: true,
                                },
                                {
                                    id: "arrow",
                                    header: "",
                                    cell: (item) =>
                                        item.condition ? "- - →" : "———→",
                                    width: 60,
                                },
                                {
                                    id: "target",
                                    header: "Target",
                                    cell: (item) => {
                                        if (item.target === "__end__")
                                            return "__end__";
                                        const node = graphConfig.nodes.find(
                                            (n) => n.id === item.target,
                                        );
                                        return node?.label || item.target;
                                    },
                                },
                                {
                                    id: "condition",
                                    header: "Condition",
                                    cell: (item) =>
                                        item.condition || (
                                            <Box color="text-status-inactive">
                                                Unconditional
                                            </Box>
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
                                                removeEdge(item._index)
                                            }
                                        />
                                    ),
                                },
                            ]}
                        />
                    )}
                </SpaceBetween>
            </Container>

            {/* State Schema Section */}
            <Container header={<Header variant="h2">State Schema</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    <Box color="text-body-secondary">
                        Define the shared state fields that flow through the
                        graph and are accessible by all nodes.
                    </Box>
                    <ColumnLayout columns={3}>
                        <FormField label="Field Name">
                            <Input
                                value={newFieldName}
                                onChange={({ detail }) =>
                                    setNewFieldName(detail.value)
                                }
                                placeholder="e.g. messages"
                            />
                        </FormField>
                        <FormField label="Field Type">
                            <Select
                                selectedOption={{
                                    label: newFieldType,
                                    value: newFieldType,
                                }}
                                onChange={({ detail }) =>
                                    setNewFieldType(
                                        detail.selectedOption?.value || "str",
                                    )
                                }
                                options={[
                                    { label: "str", value: "str" },
                                    { label: "int", value: "int" },
                                    { label: "float", value: "float" },
                                    { label: "bool", value: "bool" },
                                    { label: "list", value: "list" },
                                    { label: "dict", value: "dict" },
                                ]}
                            />
                        </FormField>
                        <FormField label=" ">
                            <Button
                                onClick={addSchemaField}
                                disabled={!newFieldName.trim()}
                            >
                                Add Field
                            </Button>
                        </FormField>
                    </ColumnLayout>
                    {stateSchemaEntries.length === 0 ? (
                        <Alert type="info">
                            No state fields defined. The graph will use a
                            default messages-only state.
                        </Alert>
                    ) : (
                        <Table
                            items={stateSchemaEntries.map(([name, type]) => ({
                                name,
                                type,
                            }))}
                            columnDefinitions={[
                                {
                                    id: "name",
                                    header: "Field Name",
                                    cell: (item) => item.name,
                                    isRowHeader: true,
                                },
                                {
                                    id: "type",
                                    header: "Type",
                                    cell: (item) => item.type,
                                },
                                {
                                    id: "actions",
                                    header: "Actions",
                                    cell: (item) => (
                                        <Button
                                            variant="icon"
                                            iconName="close"
                                            onClick={() =>
                                                removeSchemaField(item.name)
                                            }
                                        />
                                    ),
                                },
                            ]}
                        />
                    )}
                </SpaceBetween>
            </Container>

            {/* Validation Messages */}
            {validationErrors.length > 0 && (
                <Alert type="error" header="Validation Errors">
                    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                        {validationErrors.map((err, i) => (
                            <li key={i}>{err}</li>
                        ))}
                    </ul>
                </Alert>
            )}
            {warnings.length > 0 && (
                <Alert type="warning" header="Warnings">
                    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                        {warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                        ))}
                    </ul>
                </Alert>
            )}
        </SpaceBetween>
    );
}
