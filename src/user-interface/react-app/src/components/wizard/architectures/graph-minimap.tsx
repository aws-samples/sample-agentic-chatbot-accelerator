// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Background,
    Controls,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
    type Edge,
    type Node,
    type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { GraphConfiguration, GraphNodeDefinition } from "../types";

// ── Node kind helpers ───────────────────────────────────────────────────

type NodeKind = "agent" | "deterministic" | "fork" | "dynamic_map" | "end";
type LayoutDirection = "TB" | "LR";

function getNodeKind(node: GraphNodeDefinition): NodeKind {
    if (node.nodeType === "fork") return "fork";
    if (node.nodeType === "dynamic_map") return "dynamic_map";
    if (node.deterministicNodeKey) return "deterministic";
    return "agent";
}

// ── Color scheme per node kind ──────────────────────────────────────────

const KIND_COLORS: Record<NodeKind, { bg: string; border: string; text: string; badge: string }> = {
    agent: { bg: "#f5f5f5", border: "#8d6e97", text: "#16191f", badge: "#8d6e97" },
    deterministic: { bg: "#f2fcf3", border: "#037f0c", text: "#16191f", badge: "#037f0c" },
    fork: { bg: "#f0f4ff", border: "#0972d3", text: "#16191f", badge: "#0972d3" },
    dynamic_map: { bg: "#f0f0ff", border: "#6b40b2", text: "#16191f", badge: "#6b40b2" },
    end: { bg: "#fdf3ec", border: "#d13212", text: "#d13212", badge: "#d13212" },
};

const KIND_LABELS: Record<NodeKind, string> = {
    agent: "Agent",
    deterministic: "Deterministic",
    fork: "Fork",
    dynamic_map: "Dynamic Map",
    end: "END",
};

// ── Custom Node Component ───────────────────────────────────────────────

interface MinimapNodeData {
    label: string;
    kind: NodeKind;
    isEntryPoint: boolean;
    subtitle?: string;
    promptTemplate?: string;
    direction: LayoutDirection;
    [key: string]: unknown;
}

function MinimapNodeComponent({ data }: { data: MinimapNodeData }) {
    const colors = KIND_COLORS[data.kind] || KIND_COLORS.agent;
    const isVertical = data.direction === "TB";

    const containerStyle: CSSProperties = {
        background: colors.bg,
        border: `2px solid ${colors.border}`,
        borderRadius: 10,
        padding: "8px 14px",
        minWidth: 130,
        maxWidth: 220,
        fontSize: 12,
        fontFamily: "'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif",
        color: colors.text,
        textAlign: "center",
        boxShadow: data.isEntryPoint
            ? `0 0 0 3px ${colors.border}44, 0 2px 8px rgba(0,0,0,0.1)`
            : "0 1px 4px rgba(0,0,0,0.06)",
    };

    const badgeStyle: CSSProperties = {
        display: "inline-block",
        background: colors.badge,
        color: "#fff",
        fontSize: 9,
        fontWeight: 700,
        padding: "1px 6px",
        borderRadius: 3,
        marginBottom: 4,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
    };

    const entryBadgeStyle: CSSProperties = {
        display: "inline-block",
        background: "#0972d3",
        color: "#fff",
        fontSize: 8,
        fontWeight: 700,
        padding: "1px 5px",
        borderRadius: 3,
        marginLeft: 4,
        letterSpacing: "0.5px",
    };

    const labelStyle: CSSProperties = {
        fontWeight: 600,
        fontSize: 12,
        lineHeight: "16px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    };

    const subtitleStyle: CSSProperties = {
        fontSize: 10,
        lineHeight: "13px",
        opacity: 0.65,
        marginTop: 2,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    };

    const configTagsStyle: CSSProperties = {
        marginTop: 4,
        paddingTop: 4,
        borderTop: `1px dashed ${colors.border}40`,
        display: "flex",
        gap: 4,
        justifyContent: "center",
        flexWrap: "wrap",
    };

    const configTagStyle: CSSProperties = {
        fontSize: 9,
        padding: "1px 5px",
        borderRadius: 3,
        background: `${colors.border}18`,
        color: colors.border,
        fontWeight: 600,
        whiteSpace: "nowrap",
    };

    const hasConfigTags = data.kind === "agent" && data.promptTemplate;

    // Handle positions depend on layout direction
    const targetPos = isVertical ? Position.Top : Position.Left;
    const sourcePos = isVertical ? Position.Bottom : Position.Right;

    return (
        <>
            <Handle
                type="target"
                position={targetPos}
                style={{ background: colors.border, width: 6, height: 6 }}
            />
            <div style={containerStyle}>
                <div>
                    <span style={badgeStyle}>{KIND_LABELS[data.kind]}</span>
                    {data.isEntryPoint && <span style={entryBadgeStyle}>▶ ENTRY</span>}
                </div>
                <div style={labelStyle}>{data.label}</div>
                {data.subtitle && <div style={subtitleStyle}>{data.subtitle}</div>}
                {hasConfigTags && (
                    <div style={configTagsStyle}>
                        {data.promptTemplate && (
                            <span style={configTagStyle} title={data.promptTemplate}>
                                📝 Prompt
                            </span>
                        )}
                    </div>
                )}
            </div>
            <Handle
                type="source"
                position={sourcePos}
                style={{ background: colors.border, width: 6, height: 6 }}
            />
        </>
    );
}

const nodeTypes: NodeTypes = {
    minimapNode: MinimapNodeComponent,
};

// ── Dagre layout ────────────────────────────────────────────────────────

const NODE_WIDTH = 170;
const NODE_HEIGHT_BASE = 70;
const NODE_HEIGHT_WITH_CONFIG = 90;

function getLayoutedElements(nodes: Node[], edges: Edge[], direction: LayoutDirection) {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: direction,
        nodesep: 50,
        ranksep: 80,
        marginx: 30,
        marginy: 30,
    });

    nodes.forEach((node) => {
        const data = node.data as MinimapNodeData;
        const hasConfig = data.kind === "agent" && data.promptTemplate;
        const height = hasConfig ? NODE_HEIGHT_WITH_CONFIG : NODE_HEIGHT_BASE;
        g.setNode(node.id, { width: NODE_WIDTH, height });
    });

    edges.forEach((edge) => {
        g.setEdge(edge.source, edge.target);
    });

    dagre.layout(g);

    const layoutedNodes = nodes.map((node) => {
        const pos = g.node(node.id);
        return {
            ...node,
            position: {
                x: pos.x - NODE_WIDTH / 2,
                y: pos.y - pos.height / 2,
            },
        };
    });

    return { nodes: layoutedNodes, edges };
}

// ── Transform GraphConfiguration → React Flow elements ──────────────────

function transformToFlow(
    graphConfig: GraphConfiguration,
    direction: LayoutDirection,
): { nodes: Node[]; edges: Edge[] } {
    const hasEndTarget = graphConfig.edges.some((e) => e.target === "__end__");

    const flowNodes: Node[] = graphConfig.nodes.map((n) => {
        const kind = getNodeKind(n);
        const subtitle =
            kind === "agent"
                ? n.agentName
                : kind === "deterministic"
                  ? n.deterministicNodeKey
                  : undefined;

        return {
            id: n.id,
            type: "minimapNode",
            position: { x: 0, y: 0 },
            data: {
                label: n.label || n.id,
                kind,
                isEntryPoint: n.id === graphConfig.entryPoint,
                subtitle: subtitle !== (n.label || n.id) ? subtitle : undefined,
                promptTemplate: n.promptTemplate,
                direction,
            } satisfies MinimapNodeData,
        };
    });

    if (hasEndTarget) {
        flowNodes.push({
            id: "__end__",
            type: "minimapNode",
            position: { x: 0, y: 0 },
            data: {
                label: "END",
                kind: "end",
                isEntryPoint: false,
                direction,
            } satisfies MinimapNodeData,
        });
    }

    // Synthesize virtual edges for dynamic_map nodes (Send() fan-out)
    const syntheticEdges: typeof graphConfig.edges = [];
    for (const n of graphConfig.nodes) {
        if (n.nodeType === "dynamic_map" && n.dynamicMapConfig?.targetNode) {
            syntheticEdges.push({
                source: n.id,
                target: n.dynamicMapConfig.targetNode,
                condition: "Send()",
            });
        }
    }

    const allEdges = [...graphConfig.edges, ...syntheticEdges];

    const flowEdges: Edge[] = allEdges.map((e, i) => {
        const isConditional = !!e.condition;
        return {
            id: `edge-${i}`,
            source: e.source,
            target: e.target,
            label: e.condition || undefined,
            animated: isConditional,
            style: {
                stroke: isConditional ? "#0972d3" : "#687078",
                strokeWidth: 2,
                strokeDasharray: isConditional ? "6 3" : undefined,
            },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                color: isConditional ? "#0972d3" : "#687078",
                width: 18,
                height: 18,
            },
            labelStyle: {
                fontSize: 10,
                fill: "#0972d3",
                fontWeight: 600,
            },
            labelBgStyle: {
                fill: "#fff",
                fillOpacity: 0.9,
            },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
        };
    });

    return getLayoutedElements(flowNodes, flowEdges, direction);
}

// ── Button styles ───────────────────────────────────────────────────────

const overlayBtnStyle: CSSProperties = {
    background: "#fff",
    border: "1px solid #d5dbdb",
    borderRadius: 6,
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: "#0972d3",
    display: "flex",
    alignItems: "center",
    gap: 5,
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    userSelect: "none",
    whiteSpace: "nowrap",
};

const overlayBarStyle: CSSProperties = {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 10,
    display: "flex",
    gap: 6,
};

// ── Inner Flow Component (needs useReactFlow) ───────────────────────────

function MinimapFlowInner({
    nodes,
    edges,
    direction,
    onToggleDirection,
}: {
    nodes: Node[];
    edges: Edge[];
    direction: LayoutDirection;
    onToggleDirection: () => void;
}) {
    const { fitView } = useReactFlow();

    useEffect(() => {
        const timer = setTimeout(() => fitView({ padding: 0.2 }), 50);
        return () => clearTimeout(timer);
    }, [nodes, edges, fitView]);

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={1.5}
            defaultEdgeOptions={{ type: "smoothstep" }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
        >
            <Background gap={16} size={1} color="#eaeded" />
            <Controls showInteractive={false} />
            <div style={overlayBarStyle}>
                <div style={overlayBtnStyle} onClick={onToggleDirection}>
                    {direction === "TB" ? "↔ Horizontal" : "↕ Vertical"}
                </div>
            </div>
        </ReactFlow>
    );
}

// ── Main Component ──────────────────────────────────────────────────────

interface GraphMinimapProps {
    graphConfig: GraphConfiguration;
}

export default function GraphMinimap({ graphConfig }: GraphMinimapProps) {
    const [direction, setDirection] = useState<LayoutDirection>("TB");
    const containerRef = useRef<HTMLDivElement>(null);

    const toggleDirection = useCallback(() => {
        setDirection((prev) => (prev === "TB" ? "LR" : "TB"));
    }, []);

    const { nodes, edges } = useMemo(
        () => transformToFlow(graphConfig, direction),
        [graphConfig, direction],
    );

    if (graphConfig.nodes.length === 0) {
        return (
            <div
                style={{
                    padding: "24px",
                    textAlign: "center",
                    color: "#687078",
                    fontStyle: "italic",
                }}
            >
                No nodes to display.
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            style={{
                width: "100%",
                height: 400,
                border: "1px solid #eaeded",
                borderRadius: 8,
                background: "#fafafa",
                position: "relative",
            }}
        >
            <ReactFlowProvider>
                <MinimapFlowInner
                    nodes={nodes}
                    edges={edges}
                    direction={direction}
                    onToggleDirection={toggleDirection}
                />
            </ReactFlowProvider>
        </div>
    );
}
