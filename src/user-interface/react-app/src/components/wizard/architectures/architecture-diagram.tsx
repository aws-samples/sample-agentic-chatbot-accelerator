// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

/**
 * Small presentational diagrams for each agent architecture, rendered in the
 * wizard's Architecture Type tiles. Inline SVG (no asset pipeline) drawn with
 * `currentColor` so they adapt to light/dark Cloudscape themes. All four share
 * one viewBox and fixed height so the tiles stay equal-height.
 */

export type ArchKind = "single" | "agents-as-tools" | "swarm" | "graph";

const VIEW_W = 160;
const VIEW_H = 72;

// Shared node/edge styling — strokes and fills inherit the tile's text color,
// kept muted via opacity so the diagram reads as a hint, not a focal point.
const nodeProps = {
    fill: "currentColor",
    fillOpacity: 0.12,
    stroke: "currentColor",
    strokeOpacity: 0.7,
    strokeWidth: 1.5,
} as const;

const edgeProps = {
    stroke: "currentColor",
    strokeOpacity: 0.5,
    strokeWidth: 1.5,
    fill: "none",
} as const;

function Node({ cx, cy, r = 9 }: { cx: number; cy: number; r?: number }) {
    return <circle cx={cx} cy={cy} r={r} {...nodeProps} />;
}

function diagram(kind: ArchKind) {
    switch (kind) {
        case "single":
            return <Node cx={80} cy={36} r={12} />;
        case "agents-as-tools":
            // Orchestrator on top delegating to three sub-agents.
            return (
                <>
                    <line x1={80} y1={22} x2={40} y2={54} {...edgeProps} />
                    <line x1={80} y1={22} x2={80} y2={54} {...edgeProps} />
                    <line x1={80} y1={22} x2={120} y2={54} {...edgeProps} />
                    <Node cx={80} cy={18} r={10} />
                    <Node cx={40} cy={54} />
                    <Node cx={80} cy={54} />
                    <Node cx={120} cy={54} />
                </>
            );
        case "swarm":
            // Fully-meshed peers collaborating via handoffs.
            return (
                <>
                    <line x1={50} y1={22} x2={110} y2={22} {...edgeProps} />
                    <line x1={50} y1={22} x2={50} y2={52} {...edgeProps} />
                    <line x1={110} y1={22} x2={110} y2={52} {...edgeProps} />
                    <line x1={50} y1={52} x2={110} y2={52} {...edgeProps} />
                    <line x1={50} y1={22} x2={110} y2={52} {...edgeProps} />
                    <line x1={110} y1={22} x2={50} y2={52} {...edgeProps} />
                    <Node cx={50} cy={22} />
                    <Node cx={110} cy={22} />
                    <Node cx={50} cy={52} />
                    <Node cx={110} cy={52} />
                </>
            );
        case "graph":
            // Directed workflow: entry → branch → merge, with arrowheads.
            return (
                <>
                    <line x1={38} y1={36} x2={72} y2={20} {...edgeProps} markerEnd="url(#arrow)" />
                    <line x1={38} y1={36} x2={72} y2={52} {...edgeProps} markerEnd="url(#arrow)" />
                    <line x1={88} y1={20} x2={122} y2={36} {...edgeProps} markerEnd="url(#arrow)" />
                    <line x1={88} y1={52} x2={122} y2={36} {...edgeProps} markerEnd="url(#arrow)" />
                    <Node cx={30} cy={36} />
                    <Node cx={80} cy={20} />
                    <Node cx={80} cy={52} />
                    <Node cx={130} cy={36} />
                </>
            );
    }
}

export default function ArchitectureDiagram({ kind }: { kind: ArchKind }) {
    return (
        <svg
            role="presentation"
            aria-hidden="true"
            width="100%"
            height={VIEW_H}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="xMidYMid meet"
        >
            <defs>
                <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX={8}
                    refY={5}
                    markerWidth={5}
                    markerHeight={5}
                    orient="auto-start-reverse"
                >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" fillOpacity={0.5} />
                </marker>
            </defs>
            {diagram(kind)}
        </svg>
    );
}
