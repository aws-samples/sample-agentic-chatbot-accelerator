# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Tests for graph node-execution steps (spec 05).

`stream_graph_with_steps` turns a LangGraph `astream_events` stream into the
spec-02 `tool_action` / `tool_complete` WS contract. These tests drive it with
scripted event streams (no real graph) and assert the emitted WS frames.
"""

from __future__ import annotations

import app
import pytest


class FakeWebSocket:
    """Captures payloads sent to send_json (async, as FastAPI's WebSocket is)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    def events(self, event_type: str) -> list[dict]:
        return [p for p in self.sent if p.get("type") == event_type]


class FakeGraph:
    """A compiled-graph stand-in whose astream_events replays scripted events."""

    def __init__(self, events: list[dict]) -> None:
        self._events = events

    async def astream_events(self, input_state, config, version):  # noqa: ARG002
        for event in self._events:
            yield event


def _start(name: str, run_id: str) -> dict:
    return {"event": "on_chain_start", "name": name, "run_id": run_id}


def _end(name: str, run_id: str, output: dict | None = None) -> dict:
    return {
        "event": "on_chain_end",
        "name": name,
        "run_id": run_id,
        "data": {"output": output} if output is not None else {},
    }


async def _run(events: list[dict], node_ids: set[str]):
    ws = FakeWebSocket()
    result = await app.stream_graph_with_steps(
        compiled_graph=FakeGraph(events),
        input_state={"messages": ["hi"]},
        invoke_config={},
        node_ids=node_ids,
        websocket=ws,
    )
    return ws, result


@pytest.mark.asyncio
async def test_linear_graph_emits_paired_steps():
    """Each node emits a tool_action on start and a correlated tool_complete on
    end; routers (not in node_ids) are skipped; the root state is returned."""
    final_state = {"messages": ["done"], "is_complete": True}
    events = [
        # Graph root — first chain to start; its end carries the final state.
        _start("LangGraph", "root"),
        _start("node_research", "r1"),
        _end("node_research", "r1", {"research_results": "x"}),
        # A conditional router chain event — must be ignored.
        _start("should_continue", "router1"),
        _end("should_continue", "router1"),
        _start("node_writer", "w1"),
        _end("node_writer", "w1", {"messages": ["draft"]}),
        _end("LangGraph", "root", final_state),
    ]
    node_ids = {"node_research", "node_writer", "node_reviewer"}

    ws, result = await _run(events, node_ids)

    actions = ws.events("tool_action")
    completes = ws.events("tool_complete")

    # Only the two real nodes surface — the router is filtered out.
    assert [a["toolName"] for a in actions] == ["node_research", "node_writer"]
    assert [a["invocationNumber"] for a in actions] == [1, 2]
    # Node steps carry no description / parameters (graph nodes aren't tools).
    assert all(a["description"] == "" and a["parameters"] == [] for a in actions)

    # Each complete is success and correlates by invocationNumber.
    assert {c["toolName"]: c["invocationNumber"] for c in completes} == {
        "node_research": 1,
        "node_writer": 2,
    }
    assert all(c["status"] == "success" for c in completes)

    # The root on_chain_end output is returned verbatim for downstream
    # final_content / structured-output extraction.
    assert result == final_state


@pytest.mark.asyncio
async def test_fanout_disambiguates_repeated_node_ids():
    """Send()-style fan-out / loop re-entry of the same node id gets distinct
    steps; the first is the bare id, later ones get a #k suffix."""
    events = [
        _start("LangGraph", "root"),
        # Same node id executes three times (e.g. dynamic_map branches).
        _start("map_node", "b1"),
        _start("map_node", "b2"),
        _start("map_node", "b3"),
        _end("map_node", "b1"),
        _end("map_node", "b2"),
        _end("map_node", "b3"),
        _end("LangGraph", "root", {"messages": ["merged"]}),
    ]

    ws, _ = await _run(events, {"map_node"})

    actions = ws.events("tool_action")
    assert [a["toolName"] for a in actions] == [
        "map_node",
        "map_node #2",
        "map_node #3",
    ]
    # invocationNumbers are unique and monotonic across branches.
    assert [a["invocationNumber"] for a in actions] == [1, 2, 3]

    # Each branch's complete correlates by run_id to the right label/seq.
    completes = ws.events("tool_complete")
    assert {c["toolName"]: c["invocationNumber"] for c in completes} == {
        "map_node": 1,
        "map_node #2": 2,
        "map_node #3": 3,
    }


@pytest.mark.asyncio
async def test_node_error_emits_error_status():
    """on_chain_error for a node flips its tool_complete to status=error."""
    events = [
        _start("LangGraph", "root"),
        _start("node_research", "r1"),
        {"event": "on_chain_error", "name": "node_research", "run_id": "r1"},
        _end("LangGraph", "root", {"messages": ["partial"]}),
    ]

    ws, _ = await _run(events, {"node_research"})

    completes = ws.events("tool_complete")
    assert len(completes) == 1
    assert completes[0]["toolName"] == "node_research"
    assert completes[0]["invocationNumber"] == 1
    assert completes[0]["status"] == "error"
