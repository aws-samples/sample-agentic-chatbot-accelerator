# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Per-container tests: tool_action / tool_complete emission and correlation.

Covers the three entry-point containers that hold a browser WebSocket:
docker (single agent), docker-swarm, docker-agents-as-tools. docker-graph is
out of scope here: its nodes invoke sub-agents rather than local tools, so it
emits steps by streaming node lifecycle in app.py (see docker-graph's own
test_node_steps.py), not via tool callbacks.

Run with:
    pytest shared/tests/test_container_tool_steps.py -v
"""

import asyncio

import pytest
from shared.tests.ws_test_helpers import (
    FakeWebSocket,
    make_after_event,
    make_before_event,
    make_callbacks,
)

ENTRY_POINT_CONTAINERS = ["docker", "docker-swarm", "docker-agents-as-tools"]


@pytest.mark.parametrize("container", ENTRY_POINT_CONTAINERS)
async def test_before_after_emit_correlated_events(container):
    """before_tool emits tool_action; after_tool emits a tool_complete that shares
    the same invocationNumber (correlated via tool_call_id, not the live counter)."""
    callbacks = make_callbacks(container)
    ws = FakeWebSocket()
    callbacks._websocket = ws

    # Two tool calls in one turn -> invocation numbers 1 then 2.
    before1 = make_before_event("search_docs", "call-1", {"query": "abc"}, "Search")
    before2 = make_before_event("get_order", "call-2", {"id": "42"})

    callbacks.log_tool_entries(before1)
    callbacks.log_tool_entries(before2)
    # Results arrive out of order to prove correlation is by id, not arrival.
    callbacks.log_tool_results(
        make_after_event("get_order", "call-2", {"status": "success"})
    )
    callbacks.log_tool_results(
        make_after_event("search_docs", "call-1", {"status": "success"})
    )
    await asyncio.sleep(0)  # flush ensure_future-scheduled sends

    actions = ws.events("tool_action")
    completes = ws.events("tool_complete")

    assert [a["invocationNumber"] for a in actions] == [1, 2]
    assert [a["toolName"] for a in actions] == ["search_docs", "get_order"]
    # tool_action forwards param name/value pairs so the UI can show args.
    assert actions[0]["parameters"] == [{"name": "query", "value": "abc"}]

    # Each tool_complete matches its action's invocationNumber.
    by_tool = {c["toolName"]: c["invocationNumber"] for c in completes}
    assert by_tool == {"get_order": 2, "search_docs": 1}
    assert all(c["status"] == "success" for c in completes)


@pytest.mark.parametrize("container", ENTRY_POINT_CONTAINERS)
async def test_error_result_maps_to_error_status(container):
    """A tool result with status=error yields tool_complete status=error."""
    callbacks = make_callbacks(container)
    ws = FakeWebSocket()
    callbacks._websocket = ws

    callbacks.log_tool_entries(make_before_event("boom", "call-1", {}))
    callbacks.log_tool_results(make_after_event("boom", "call-1", {"status": "error"}))
    await asyncio.sleep(0)

    completes = ws.events("tool_complete")
    assert len(completes) == 1
    assert completes[0]["status"] == "error"
    assert completes[0]["invocationNumber"] == 1


@pytest.mark.parametrize("container", ENTRY_POINT_CONTAINERS)
async def test_no_websocket_is_noop(container):
    """Without a browser WS (the /invocations SSE path), callbacks emit nothing
    and never raise."""
    callbacks = make_callbacks(container)
    assert callbacks._websocket is None

    callbacks.log_tool_entries(make_before_event("search_docs", "call-1", {"q": "x"}))
    callbacks.log_tool_results(
        make_after_event("search_docs", "call-1", {"status": "success"})
    )
    await asyncio.sleep(0)
    # Nothing to assert beyond "did not raise"; there is no WS to inspect.
