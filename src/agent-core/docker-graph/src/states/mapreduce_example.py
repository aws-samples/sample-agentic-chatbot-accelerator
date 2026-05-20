# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""MapReducePipelineState — parallel map + deterministic reduce pipeline.

Pipeline flow::

    fan_out ──► agent_a ──┐
                          ├──► reduce ──► END
           ──► agent_b ──┘

**Map phase** — both branches run in parallel (LangGraph fans out from
``fan_out`` via two unconditional edges).  Each agent node appends its
structured output to the ``partial_templates`` accumulator list using
the ``Annotated[list, operator.add]`` reducer.

**Reduce phase** — the ``reduce`` node is a *deterministic node*
(``deterministicNodeKey: merge_template_partials``).  It is a pure-Python
function with no LLM call.  It merges the two partial results into a
single combined output.

This module is auto-registered with :mod:`state_registry` and
:mod:`deterministic_node_registry` on import.

Example graph configuration (created via the UI)::

    {
      "stateClass": "MapReducePipelineState",
      "entryPoint": "fan_out",
      "nodes": [
        { "id": "fan_out",    "nodeType": "fork" },
        { "id": "agent_a",   "agentName": "agent_a" },
        { "id": "agent_b",   "agentName": "agent_b" },
        { "id": "reduce",    "deterministicNodeKey": "merge_template_partials" }
      ],
      "edges": [
        { "source": "fan_out",  "target": "agent_a" },
        { "source": "fan_out",  "target": "agent_b" },
        { "source": "agent_a",  "target": "reduce" },
        { "source": "agent_b",  "target": "reduce" },
        { "source": "reduce",   "target": "__end__" }
      ]
    }
"""

from __future__ import annotations

import operator
from typing import Annotated, TypedDict

from ..deterministic_node_registry import register_deterministic_node
from ..state_registry import register_state_class


def _last_value(current: str, new: str) -> str:
    """Reducer: last writer wins for the messages text channel.

    Required because parallel fan-in branches both write to ``messages``
    and LangGraph refuses to merge two values into a field without a
    reducer.  The reduce node overwrites it with the final summary anyway.
    """
    return new


# ── State class ──────────────────────────────────────────────────────────


class MapReducePipelineState(TypedDict):
    """State flowing through the map-reduce pipeline.

    **Map-reduce convention**: Each map-phase agent node appends a single
    entry ``{"source": "<node_id>", "data": <structured_output>}`` to
    ``partial_templates``.  The ``Annotated[list, operator.add]`` reducer
    accumulates entries from both parallel branches before the ``reduce``
    node runs.
    """

    # ── Text channel (mandatory for graph framework) ─────────────────
    messages: Annotated[str, _last_value]

    # ── Map outputs — fan-in accumulator ─────────────────────────────
    # operator.add concatenates the lists from both parallel branches.
    # Each entry has the shape: {"source": str, "data": dict}
    partial_templates: Annotated[list[dict], operator.add]

    # ── Reduce output ────────────────────────────────────────────────
    merged_template: dict


# ── Registration ─────────────────────────────────────────────────────────

register_state_class(
    key="MapReducePipelineState",
    cls=MapReducePipelineState,
    label="Map-Reduce Template Assembly",
    description=(
        "Parallel map phase: two agents each produce a partial output "
        "independently. Reduce phase: deterministic Python merge combines "
        "the partials into a single result."
    ),
    fields=list(MapReducePipelineState.__annotations__.keys()),
)


# ── Deterministic merge function ─────────────────────────────────────────


def merge_template_partials(state: dict) -> dict:
    """Deterministic node: merge partial outputs from map-phase agents.

    Reads ``partial_templates`` (accumulated by the two map-phase agent
    nodes) from the graph state, combines them into a single merged dict,
    and returns an enriched result.

    State keys consumed:
        ``partial_templates`` — list of ``{"source": str, "data": dict}``

    State keys produced:
        ``merged_template``   — combined ``{field: value}`` from all sources
        ``messages``          — human-readable summary string
    """
    partials: list[dict] = state.get("partial_templates") or []

    # Combine all data dicts from each source
    merged: dict = {}
    for entry in partials:
        data = entry.get("data") or {}
        source = entry.get("source", "unknown")
        # Prefix keys with source to avoid collisions
        for key, value in data.items():
            merged[f"{source}.{key}"] = value

    summary = (
        f"Merge complete: {len(merged)} fields combined from {len(partials)} source(s)."
    )

    return {
        "merged_template": merged,
        "messages": summary,
    }


register_deterministic_node(
    key="merge_template_partials",
    fn=merge_template_partials,
    label="Merge Template Partials",
    description=(
        "Deterministic merge of partial outputs produced by parallel "
        "agent branches. Combines all structured output fields into a "
        "single merged dict, prefixed by source node ID."
    ),
)
