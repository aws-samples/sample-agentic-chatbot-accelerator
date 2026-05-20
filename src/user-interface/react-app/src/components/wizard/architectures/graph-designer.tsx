// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Badge,
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
    Textarea,
    Toggle,
} from "@cloudscape-design/components";
import React from "react";
import { RuntimeSummary } from "../../../API";
import {
    GraphConfiguration,
    GraphEdgeDefinition,
    GraphNodeDefinition,
    PredefinedDeterministicNode,
    PredefinedStateClass,
} from "../types";
import GraphMinimap from "./graph-minimap";

// ── Node kind helpers ─────────────────────────────────────────────────────────

type NodeKind = "agent" | "deterministic" | "fork" | "dynamic_map";

function getNodeKind(node: GraphNodeDefinition): NodeKind {
    if (node.nodeType === "fork") return "fork";
    if (node.nodeType === "dynamic_map") return "dynamic_map";
    if (node.deterministicNodeKey) return "deterministic";
    return "agent";
}

function nodeKindBadge(kind: NodeKind) {
    if (kind === "fork") return <Badge color="blue">fork</Badge>;
    if (kind === "dynamic_map") return <Badge color="blue">dynamic_map</Badge>;
    if (kind === "deterministic") return <Badge color="green">deterministic</Badge>;
    return <Badge color="grey">agent</Badge>;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface GraphDesignerProps {
    graphConfig: GraphConfiguration;
    setGraphConfig: React.Dispatch<React.SetStateAction<GraphConfiguration>>;
    availableAgents: RuntimeSummary[];
    availableStateClasses: PredefinedStateClass[];
    availableDeterministicNodes: PredefinedDeterministicNode[];
    currentAgentName: string;
}

export default function GraphDesigner({
    graphConfig,
    setGraphConfig,
    availableAgents,
    availableStateClasses,
    availableDeterministicNodes,
    currentAgentName,
}: GraphDesignerProps) {
    // Filter out the current agent being created to prevent self-referencing
    const selectableAgents = availableAgents.filter((a) => a.agentName !== currentAgentName);

    // ── Local state for the "Add Node" panel ──────────────────────────────────
    const [addNodeKind, setAddNodeKind] = React.useState<NodeKind>("agent");
    const [newForkId, setNewForkId] = React.useState("");

    // ── Expandable node detail ────────────────────────────────────────────────
    const [expandedNodeId, setExpandedNodeId] = React.useState<string | null>(null);

    // ── Node management ───────────────────────────────────────────────────────

    const addAgentNode = (agentName: string) => {
        const agent = selectableAgents.find((a) => a.agentName === agentName);
        if (!agent) return;

        const existingCount = graphConfig.nodes.filter((n) => n.agentName === agentName).length;
        const nodeId = existingCount > 0 ? `${agentName}_${existingCount + 1}` : agentName;

        const newNode: GraphNodeDefinition = {
            id: nodeId,
            agentName,
            endpointName: "DEFAULT",
            label: nodeId,
        };

        setGraphConfig((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
    };

    const addDeterministicNode = (key: string) => {
        const fn = availableDeterministicNodes.find((d) => d.key === key);
        if (!fn) return;

        const existingCount = graphConfig.nodes.filter(
            (n) => n.deterministicNodeKey === key,
        ).length;
        const nodeId = existingCount > 0 ? `${key}_${existingCount + 1}` : key;

        const newNode: GraphNodeDefinition = {
            id: nodeId,
            deterministicNodeKey: key,
            endpointName: "DEFAULT",
            label: fn.label,
        };

        setGraphConfig((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
    };

    const addForkNode = () => {
        const id = newForkId.trim() || "fan_out";
        if (graphConfig.nodes.some((n) => n.id === id)) return;
        const newNode: GraphNodeDefinition = {
            id,
            nodeType: "fork",
            endpointName: "DEFAULT",
            label: id,
        };
        setGraphConfig((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
        setNewForkId("");
    };

    const removeNode = (nodeId: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.filter((n) => n.id !== nodeId),
            edges: prev.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
            entryPoint: prev.entryPoint === nodeId ? "" : prev.entryPoint,
        }));
    };

    const updateNodeEndpoint = (nodeId: string, endpointName: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, endpointName } : n)),
        }));
    };

    const updateNodeLabel = (nodeId: string, label: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, label } : n)),
        }));
    };

    const updateNodePromptTemplate = (nodeId: string, promptTemplate: string) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) =>
                n.id === nodeId ? { ...n, promptTemplate: promptTemplate || undefined } : n,
            ),
        }));
    };

    const updateNodeDynamicMapConfig = (
        nodeId: string,
        field: "sourceKey" | "targetNode" | "itemStateKey",
        value: string,
    ) => {
        setGraphConfig((prev) => ({
            ...prev,
            nodes: prev.nodes.map((n) =>
                n.id === nodeId && n.dynamicMapConfig
                    ? { ...n, dynamicMapConfig: { ...n.dynamicMapConfig, [field]: value } }
                    : n,
            ),
        }));
    };

    // ── Edge management ───────────────────────────────────────────────────────
    const [newEdgeSource, setNewEdgeSource] = React.useState<string>("");
    const [newEdgeTarget, setNewEdgeTarget] = React.useState<string>("");
    const [newEdgeCondition, setNewEdgeCondition] = React.useState<string>("");
    const [newEdgeIsConditional, setNewEdgeIsConditional] = React.useState(false);

    const nodeIdOptions = graphConfig.nodes.map((n) => ({
        label: n.label || n.id,
        value: n.id,
        description: getNodeKind(n),
    }));

    const targetOptions = [
        ...nodeIdOptions,
        { label: "__end__", value: "__end__", description: "Terminal node" },
    ];

    const addEdge = () => {
        if (!newEdgeSource || !newEdgeTarget) return;
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

        setGraphConfig((prev) => ({ ...prev, edges: [...prev.edges, edge] }));
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

    // ── State schema management ───────────────────────────────────────────────
    const [newFieldName, setNewFieldName] = React.useState("");
    const [newFieldType, setNewFieldType] = React.useState("str");

    const stateSchemaEntries = Object.entries(graphConfig.stateSchema);

    const addSchemaField = () => {
        if (!newFieldName.trim()) return;
        if (graphConfig.stateSchema[newFieldName.trim()] !== undefined) return;
        setGraphConfig((prev) => ({
            ...prev,
            stateSchema: { ...prev.stateSchema, [newFieldName.trim()]: newFieldType },
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

    // ── Validation ────────────────────────────────────────────────────────────
    const getValidationErrors = (): string[] => {
        const errors: string[] = [];
        if (graphConfig.nodes.length === 0) {
            errors.push("At least one node is required.");
        }
        if (graphConfig.nodes.length > 0 && !graphConfig.entryPoint) {
            errors.push("An entry point is required. Select one node as the graph entry point.");
        }
        if (
            graphConfig.entryPoint &&
            !graphConfig.nodes.some((n) => n.id === graphConfig.entryPoint)
        ) {
            errors.push(
                `Entry point '${graphConfig.entryPoint}' does not match any node in the graph.`,
            );
        }
        const nodesWithOutgoing = new Set(graphConfig.edges.map((e) => e.source));
        const terminalTargets = new Set(
            graphConfig.edges.filter((e) => e.target === "__end__").map((e) => e.source),
        );
        for (const node of graphConfig.nodes) {
            if (node.nodeType === "dynamic_map") continue;
            if (!nodesWithOutgoing.has(node.id) && !terminalTargets.has(node.id)) {
                errors.push(`Node '${node.id}' has no outgoing edges and is not terminal.`);
            }
        }
        return errors;
    };

    const getWarnings = (): string[] => {
        const warnings: string[] = [];
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

    // ── Endpoint options for agent nodes ──────────────────────────────────────
    const getEndpointOptions = (agentName: string) => {
        const agent = availableAgents.find((a) => a.agentName === agentName);
        const options: { label: string; value: string }[] = [];
        if (agent?.qualifierToVersion) {
            try {
                const qtv = JSON.parse(agent.qualifierToVersion);
                if (qtv && typeof qtv === "object") {
                    options.push(...Object.keys(qtv).map((key) => ({ label: key, value: key })));
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

    // ── Dynamic Map local state ───────────────────────────────────────────────
    const [newDmId, setNewDmId] = React.useState("");
    const [newDmSourceKey, setNewDmSourceKey] = React.useState("");
    const [newDmTargetNode, setNewDmTargetNode] = React.useState("");
    const [newDmItemStateKey, setNewDmItemStateKey] = React.useState("");

    const addDynamicMapNode = () => {
        const id = newDmId.trim() || "dynamic_fan_out";
        if (graphConfig.nodes.some((n) => n.id === id)) return;
        if (!newDmSourceKey.trim() || !newDmTargetNode.trim() || !newDmItemStateKey.trim()) return;

        const newNode: GraphNodeDefinition = {
            id,
            nodeType: "dynamic_map",
            endpointName: "DEFAULT",
            label: id,
            dynamicMapConfig: {
                sourceKey: newDmSourceKey.trim(),
                targetNode: newDmTargetNode.trim(),
                itemStateKey: newDmItemStateKey.trim(),
            },
        };
        setGraphConfig((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
        setNewDmId("");
        setNewDmSourceKey("");
        setNewDmTargetNode("");
        setNewDmItemStateKey("");
    };

    const kindOptions = [
        { label: "Agent", value: "agent", description: "Invoke an existing AgentCore runtime" },
        {
            label: "Deterministic",
            value: "deterministic",
            description: "Run a pure-Python function (no LLM)",
        },
        {
            label: "Fork",
            value: "fork",
            description: "Fan-out pass-through for parallel branches",
        },
        {
            label: "Dynamic Map",
            value: "dynamic_map",
            description: "Send()-based parallel fan-out over a runtime list",
        },
    ];

    return (
        <SpaceBetween direction="vertical" size="l">
            {/* ── Nodes Section ───────────────────────────────────────────── */}
            <Container header={<Header variant="h2">Graph Nodes</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    {/* Node kind picker */}
                    <FormField label="Node Kind" description="Choose what kind of node to add">
                        <Select
                            selectedOption={
                                kindOptions.find((o) => o.value === addNodeKind) || kindOptions[0]
                            }
                            onChange={({ detail }) =>
                                setAddNodeKind(
                                    (detail.selectedOption?.value as NodeKind) || "agent",
                                )
                            }
                            options={kindOptions}
                        />
                    </FormField>

                    {/* Agent node picker */}
                    {addNodeKind === "agent" && (
                        <FormField
                            label="Add Agent Node"
                            description="Select an existing agent to add as a graph node"
                        >
                            <Select
                                placeholder="Select an agent..."
                                options={selectableAgents
                                    .filter(
                                        (a) =>
                                            !graphConfig.nodes.some(
                                                (n) => n.agentName === a.agentName,
                                            ),
                                    )
                                    .map((a) => ({
                                        label: a.agentName,
                                        value: a.agentName,
                                        description: a.architectureType || undefined,
                                    }))}
                                onChange={({ detail }) => {
                                    if (detail.selectedOption?.value) {
                                        addAgentNode(detail.selectedOption.value);
                                    }
                                }}
                                selectedOption={null}
                                filteringType="auto"
                            />
                        </FormField>
                    )}

                    {/* Deterministic node picker */}
                    {addNodeKind === "deterministic" && (
                        <FormField
                            label="Add Deterministic Node"
                            description="Select a registered deterministic function"
                        >
                            {availableDeterministicNodes.length === 0 ? (
                                <Alert type="info">
                                    No deterministic nodes are registered. Add entries to{" "}
                                    <code>deterministicNodeRegistry</code> in your config.
                                </Alert>
                            ) : (
                                <Select
                                    placeholder="Select a function..."
                                    options={availableDeterministicNodes.map((d) => ({
                                        label: d.label,
                                        value: d.key,
                                        description: d.description,
                                    }))}
                                    onChange={({ detail }) => {
                                        if (detail.selectedOption?.value) {
                                            addDeterministicNode(detail.selectedOption.value);
                                        }
                                    }}
                                    selectedOption={null}
                                    filteringType="auto"
                                />
                            )}
                        </FormField>
                    )}

                    {/* Fork node creator */}
                    {addNodeKind === "fork" && (
                        <FormField
                            label="Add Fork Node"
                            description="A pass-through node that fans out to parallel branches. Enter a unique node ID."
                        >
                            <SpaceBetween direction="horizontal" size="xs">
                                <Input
                                    value={newForkId}
                                    onChange={({ detail }) => setNewForkId(detail.value)}
                                    placeholder="e.g. fan_out"
                                />
                                <Button
                                    onClick={addForkNode}
                                    disabled={graphConfig.nodes.some(
                                        (n) => n.id === (newForkId.trim() || "fan_out"),
                                    )}
                                >
                                    Add Fork
                                </Button>
                            </SpaceBetween>
                        </FormField>
                    )}

                    {/* Dynamic Map node creator */}
                    {addNodeKind === "dynamic_map" && (
                        <FormField
                            label="Add Dynamic Map Node"
                            description="A Send()-based fan-out that spawns parallel branches over a list at runtime."
                        >
                            <SpaceBetween direction="vertical" size="xs">
                                <ColumnLayout columns={2}>
                                    <FormField label="Node ID">
                                        <Input
                                            value={newDmId}
                                            onChange={({ detail }) => setNewDmId(detail.value)}
                                            placeholder="e.g. dynamic_fan_out"
                                        />
                                    </FormField>
                                    <FormField
                                        label="Source Key"
                                        description="State field containing the list to fan over"
                                    >
                                        <Input
                                            value={newDmSourceKey}
                                            onChange={({ detail }) =>
                                                setNewDmSourceKey(detail.value)
                                            }
                                            placeholder="e.g. templates"
                                        />
                                    </FormField>
                                    <FormField
                                        label="Target Node"
                                        description="Node ID to Send() each item to"
                                    >
                                        <Select
                                            expandToViewport
                                            selectedOption={
                                                newDmTargetNode
                                                    ? nodeIdOptions.find(
                                                          (o) => o.value === newDmTargetNode,
                                                      ) || {
                                                          label: newDmTargetNode,
                                                          value: newDmTargetNode,
                                                      }
                                                    : null
                                            }
                                            onChange={({ detail }) =>
                                                setNewDmTargetNode(
                                                    detail.selectedOption?.value || "",
                                                )
                                            }
                                            options={nodeIdOptions}
                                            placeholder="Select target node..."
                                            filteringType="auto"
                                        />
                                    </FormField>
                                    <FormField
                                        label="Item State Key"
                                        description="State key set per-branch with each item"
                                    >
                                        <Input
                                            value={newDmItemStateKey}
                                            onChange={({ detail }) =>
                                                setNewDmItemStateKey(detail.value)
                                            }
                                            placeholder="e.g. template_name"
                                        />
                                    </FormField>
                                </ColumnLayout>
                                <Button
                                    onClick={addDynamicMapNode}
                                    disabled={
                                        !newDmSourceKey.trim() ||
                                        !newDmTargetNode.trim() ||
                                        !newDmItemStateKey.trim() ||
                                        graphConfig.nodes.some(
                                            (n) => n.id === (newDmId.trim() || "dynamic_fan_out"),
                                        )
                                    }
                                >
                                    Add Dynamic Map
                                </Button>
                            </SpaceBetween>
                        </FormField>
                    )}

                    {/* Node list */}
                    {graphConfig.nodes.length === 0 ? (
                        <Alert type="info">
                            No nodes added yet. Select a node kind above and add one.
                        </Alert>
                    ) : (
                        <Table
                            items={graphConfig.nodes}
                            columnDefinitions={[
                                {
                                    id: "id",
                                    header: "Node ID",
                                    cell: (item) => <Box fontWeight="bold">{item.id}</Box>,
                                    isRowHeader: true,
                                    width: 180,
                                },
                                {
                                    id: "kind",
                                    header: "Kind",
                                    cell: (item) => nodeKindBadge(getNodeKind(item)),
                                    width: 120,
                                },
                                {
                                    id: "reference",
                                    header: "Agent / Function",
                                    cell: (item) => {
                                        const kind = getNodeKind(item);
                                        if (kind === "fork") return <Box color="text-status-inactive" fontSize="body-s">built-in</Box>;
                                        if (kind === "dynamic_map" && item.dynamicMapConfig) {
                                            const cfg = item.dynamicMapConfig;
                                            return <Box fontSize="body-s">Send({cfg.sourceKey}) → {cfg.targetNode}</Box>;
                                        }
                                        if (kind === "deterministic") return <Box fontWeight="bold" fontSize="body-s">{item.deterministicNodeKey}</Box>;
                                        return <span>{item.agentName}</span>;
                                    },
                                },
                                {
                                    id: "entryPoint",
                                    header: "Entry Point",
                                    cell: (item) => (
                                        <Button
                                            variant={graphConfig.entryPoint === item.id ? "primary" : "normal"}
                                            onClick={() => setGraphConfig((prev) => ({ ...prev, entryPoint: item.id }))}
                                        >
                                            {graphConfig.entryPoint === item.id ? "✓ Entry" : "Set"}
                                        </Button>
                                    ),
                                    width: 100,
                                },
                                {
                                    id: "actions",
                                    header: "Actions",
                                    cell: (item) => (
                                        <SpaceBetween direction="horizontal" size="xs">
                                            <Button
                                                variant="icon"
                                                iconName={expandedNodeId === item.id ? "angle-up" : "angle-down"}
                                                onClick={() => setExpandedNodeId(expandedNodeId === item.id ? null : item.id)}
                                                ariaLabel={expandedNodeId === item.id ? "Collapse settings" : "Expand settings"}
                                            />
                                            <Button variant="icon" iconName="close" onClick={() => removeNode(item.id)} ariaLabel="Remove node" />
                                        </SpaceBetween>
                                    ),
                                    width: 100,
                                },
                            ]}
                        />
                    )}

                    {/* Expanded node detail panel */}
                    {expandedNodeId && (() => {
                        const item = graphConfig.nodes.find((n) => n.id === expandedNodeId);
                        if (!item) return null;
                        const kind = getNodeKind(item);
                        const isAgent = kind === "agent";
                        const isDynamicMap = kind === "dynamic_map";

                        return (
                            <Box padding={{ horizontal: "l", vertical: "m" }}>
                                <SpaceBetween direction="vertical" size="m">
                                    <Header variant="h3">Settings for &ldquo;{item.label || item.id}&rdquo;</Header>
                                    <ColumnLayout columns={isAgent || isDynamicMap ? 2 : 1} variant="text-grid">
                                        <FormField label="Label" description="Display name for this node">
                                            <Input value={item.label || ""} onChange={({ detail }) => updateNodeLabel(item.id, detail.value)} placeholder={item.id} />
                                        </FormField>

                                        {isDynamicMap && item.dynamicMapConfig && (
                                            <>
                                                <FormField label="Source Key" description="State field containing the list to fan over">
                                                    <Input value={item.dynamicMapConfig.sourceKey} onChange={({ detail }) => updateNodeDynamicMapConfig(item.id, "sourceKey", detail.value)} />
                                                </FormField>
                                                <FormField label="Target Node" description="Node ID each Send() dispatches to">
                                                    <Select
                                                        expandToViewport
                                                        selectedOption={nodeIdOptions.find((o) => o.value === item.dynamicMapConfig!.targetNode) || { label: item.dynamicMapConfig.targetNode, value: item.dynamicMapConfig.targetNode }}
                                                        onChange={({ detail }) => updateNodeDynamicMapConfig(item.id, "targetNode", detail.selectedOption?.value || "")}
                                                        options={nodeIdOptions.filter((o) => o.value !== item.id)}
                                                    />
                                                </FormField>
                                                <FormField label="Item State Key" description="State key set per-branch with each item">
                                                    <Input value={item.dynamicMapConfig.itemStateKey} onChange={({ detail }) => updateNodeDynamicMapConfig(item.id, "itemStateKey", detail.value)} />
                                                </FormField>
                                            </>
                                        )}

                                        {isAgent && (
                                            <FormField label="Endpoint" description="Which endpoint/version to invoke">
                                                <Select
                                                    expandToViewport
                                                    selectedOption={getEndpointOptions(item.agentName!).find((o) => o.value === item.endpointName) || { label: item.endpointName, value: item.endpointName }}
                                                    onChange={({ detail }) => updateNodeEndpoint(item.id, detail.selectedOption?.value || "DEFAULT")}
                                                    options={getEndpointOptions(item.agentName!)}
                                                />
                                            </FormField>
                                        )}

                                        {isAgent && (
                                            <FormField label="Prompt Template" description="Optional override with {variable} placeholders. Leave empty to use the graph-level prompt.">
                                                <Textarea value={item.promptTemplate || ""} onChange={({ detail }) => updateNodePromptTemplate(item.id, detail.value)} placeholder="Uses graph prompt by default" rows={4} />
                                            </FormField>
                                        )}
                                    </ColumnLayout>
                                </SpaceBetween>
                            </Box>
                        );
                    })()}
                </SpaceBetween>
            </Container>

            {/* ── Edges Section ───────────────────────────────────────────── */}
            <Container header={<Header variant="h2">Graph Edges</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    <ColumnLayout columns={newEdgeIsConditional ? 4 : 3}>
                        <FormField label="Source Node">
                            <Select
                                placeholder="Select source..."
                                options={nodeIdOptions.filter((o) => o.value !== newEdgeTarget)}
                                selectedOption={newEdgeSource ? nodeIdOptions.find((o) => o.value === newEdgeSource) || null : null}
                                onChange={({ detail }) => setNewEdgeSource(detail.selectedOption?.value || "")}
                            />
                        </FormField>
                        <FormField label="Target Node">
                            <Select
                                placeholder="Select target..."
                                options={targetOptions.filter((o) => o.value !== newEdgeSource)}
                                selectedOption={newEdgeTarget ? targetOptions.find((o) => o.value === newEdgeTarget) || null : null}
                                onChange={({ detail }) => setNewEdgeTarget(detail.selectedOption?.value || "")}
                            />
                        </FormField>
                        {newEdgeIsConditional && (
                            <FormField label="Condition Expression">
                                <Input value={newEdgeCondition} onChange={({ detail }) => setNewEdgeCondition(detail.value)} placeholder="e.g. approved, rejected, done" />
                            </FormField>
                        )}
                        <FormField label=" ">
                            <SpaceBetween direction="horizontal" size="xs">
                                <Toggle checked={newEdgeIsConditional} onChange={({ detail }) => setNewEdgeIsConditional(detail.checked)}>Conditional</Toggle>
                                <Button onClick={addEdge} disabled={!newEdgeSource || !newEdgeTarget}>Add Edge</Button>
                            </SpaceBetween>
                        </FormField>
                    </ColumnLayout>
                    {graphConfig.edges.length === 0 ? (
                        <Alert type="info">No edges defined yet. Add edges to connect your nodes.</Alert>
                    ) : (
                        <Table
                            items={graphConfig.edges.map((e, i) => ({ ...e, _index: i }))}
                            columnDefinitions={[
                                { id: "source", header: "Source", cell: (item) => graphConfig.nodes.find((n) => n.id === item.source)?.label || item.source, isRowHeader: true },
                                { id: "arrow", header: "", cell: (item) => (item.condition ? "- - →" : "———→"), width: 60 },
                                { id: "target", header: "Target", cell: (item) => item.target === "__end__" ? "__end__" : (graphConfig.nodes.find((n) => n.id === item.target)?.label || item.target) },
                                { id: "condition", header: "Condition", cell: (item) => item.condition || <Box color="text-status-inactive">Unconditional</Box> },
                                { id: "actions", header: "Actions", cell: (item) => <Button variant="icon" iconName="close" onClick={() => removeEdge(item._index)} /> },
                            ]}
                        />
                    )}
                </SpaceBetween>
            </Container>

            {/* ── Graph Preview ────────────────────────────────────────────── */}
            {graphConfig.nodes.length > 0 && graphConfig.edges.length > 0 && (
                <Container header={<Header variant="h2" description="Live preview of your graph topology. Use the button to switch orientation.">Graph Preview</Header>}>
                    <GraphMinimap graphConfig={graphConfig} />
                </Container>
            )}

            {/* ── State Schema Section ─────────────────────────────────────── */}
            <Container header={<Header variant="h2">State Schema</Header>}>
                <SpaceBetween direction="vertical" size="m">
                    <Box color="text-body-secondary">
                        Choose how to define the shared state that flows through the graph. Use{" "}
                        <b>Custom</b> to define flat fields manually, or select a <b>Predefined</b>{" "}
                        state class for complex pipelines with typed structures, reducers, and nested types.
                    </Box>

                    <FormField label="State Mode">
                        <Select
                            selectedOption={
                                graphConfig.stateClass
                                    ? { label: `Predefined: ${availableStateClasses.find((s) => s.key === graphConfig.stateClass)?.label || graphConfig.stateClass}`, value: graphConfig.stateClass }
                                    : { label: "Custom (define flat fields)", value: "__custom__" }
                            }
                            onChange={({ detail }) => {
                                const val = detail.selectedOption?.value;
                                if (!val || val === "__custom__") {
                                    setGraphConfig((prev) => {
                                        const { stateClass: _, ...rest } = prev;
                                        return { ...rest, stateClass: undefined };
                                    });
                                } else {
                                    setGraphConfig((prev) => ({ ...prev, stateSchema: {}, stateClass: val }));
                                }
                            }}
                            options={[
                                { label: "Custom (define flat fields)", value: "__custom__", description: "Define simple state fields with primitive types (str, int, dict, ...)" },
                                ...availableStateClasses.map((sc) => ({ label: sc.label, value: sc.key, description: sc.description })),
                            ]}
                        />
                    </FormField>

                    {graphConfig.stateClass && (() => {
                        const selected = availableStateClasses.find((s) => s.key === graphConfig.stateClass);
                        if (!selected) return null;
                        return (
                            <Alert type="info" header={`${selected.label} (${selected.key})`}>
                                <p>{selected.description}</p>
                                <Box margin={{ top: "xs" }}><b>Fields:</b> <span style={{ fontFamily: "monospace" }}>{selected.fields.join(", ")}</span></Box>
                            </Alert>
                        );
                    })()}

                    {!graphConfig.stateClass && (
                        <>
                            <ColumnLayout columns={3}>
                                <FormField label="Field Name">
                                    <Input value={newFieldName} onChange={({ detail }) => setNewFieldName(detail.value)} placeholder="e.g. messages" />
                                </FormField>
                                <FormField label="Field Type">
                                    <Select
                                        selectedOption={{ label: newFieldType, value: newFieldType }}
                                        onChange={({ detail }) => setNewFieldType(detail.selectedOption?.value || "str")}
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
                                    <Button onClick={addSchemaField} disabled={!newFieldName.trim()}>Add Field</Button>
                                </FormField>
                            </ColumnLayout>
                            {stateSchemaEntries.length === 0 ? (
                                <Alert type="info">No state fields defined. The graph will use a default messages-only state.</Alert>
                            ) : (
                                <Table
                                    items={stateSchemaEntries.map(([name, type]) => ({ name, type }))}
                                    columnDefinitions={[
                                        { id: "name", header: "Field Name", cell: (item) => item.name, isRowHeader: true },
                                        { id: "type", header: "Type", cell: (item) => item.type },
                                        { id: "actions", header: "Actions", cell: (item) => <Button variant="icon" iconName="close" onClick={() => removeSchemaField(item.name)} /> },
                                    ]}
                                />
                            )}
                        </>
                    )}
                </SpaceBetween>
            </Container>

            {/* ── Validation Messages ──────────────────────────────────────── */}
            {validationErrors.length > 0 && (
                <Alert type="error" header="Validation Errors">
                    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                        {validationErrors.map((err, i) => <li key={i}>{err}</li>)}
                    </ul>
                </Alert>
            )}
            {warnings.length > 0 && (
                <Alert type="warning" header="Warnings">
                    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                        {warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                </Alert>
            )}
        </SpaceBetween>
    );
}
