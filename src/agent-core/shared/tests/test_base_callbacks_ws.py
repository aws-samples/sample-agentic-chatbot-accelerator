# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Unit tests for the WebSocket tool-step helpers on BaseAgentCallbacks.

Run with:
    pytest shared/tests/test_base_callbacks_ws.py -v
"""

import asyncio
import logging

import pytest
from shared.base_callbacks import BaseAgentCallbacks


class FakeWebSocket:
    """Captures payloads passed to send_json (an async method, as FastAPI's is)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.fixture
def callbacks() -> BaseAgentCallbacks:
    return BaseAgentCallbacks(logging.getLogger("test"), "session-1", "user-1")


@pytest.mark.asyncio
async def test_send_tool_action_payload(callbacks):
    """tool_action carries name, description, param names only, and invocationNumber."""
    ws = FakeWebSocket()
    callbacks._websocket = ws
    callbacks._nb_tool_invocations = 2

    callbacks._send_tool_action(
        "search_documentation",
        "Retrieves order details",
        [{"name": "query", "value": "secret-value"}],
    )
    await asyncio.sleep(0)  # let the ensure_future-scheduled send run

    assert ws.sent == [
        {
            "type": "tool_action",
            "toolName": "search_documentation",
            "description": "Retrieves order details",
            "parameters": ["query"],  # values are NOT forwarded
            "invocationNumber": 2,
        }
    ]


@pytest.mark.asyncio
async def test_send_tool_complete_payload(callbacks):
    """tool_complete is minimal: name, invocationNumber, status — no result content."""
    ws = FakeWebSocket()
    callbacks._websocket = ws

    callbacks._send_tool_complete("search_documentation", 2, "success")
    await asyncio.sleep(0)  # let the ensure_future-scheduled send run

    assert ws.sent == [
        {
            "type": "tool_complete",
            "toolName": "search_documentation",
            "invocationNumber": 2,
            "status": "success",
        }
    ]


def test_send_ws_event_noop_when_no_websocket(callbacks):
    """No WebSocket attached (e.g. /invocations SSE path) => silent no-op, no raise."""
    callbacks._websocket = None
    # Must not raise even though there is no running loop.
    callbacks._send_tool_action("foo", "", [{"name": "x"}])
    callbacks._send_tool_complete("foo", 1, "success")


@pytest.mark.asyncio
async def test_send_ws_event_never_raises_on_send_failure(callbacks):
    """A failing send is logged as a warning, never raised into the agent run."""

    class BrokenWebSocket:
        def send_json(self, payload):  # not even a coroutine -> triggers except
            raise RuntimeError("connection closed")

    callbacks._websocket = BrokenWebSocket()
    # Should swallow the error.
    callbacks._send_tool_complete("foo", 1, "success")


@pytest.mark.parametrize(
    "result, expected",
    [
        ({"status": "success", "content": []}, "success"),
        ({"status": "error", "content": []}, "error"),
        ({"content": []}, "success"),  # unknown shape defaults to success
        ("plain string", "success"),
        (None, "success"),
    ],
)
def test_tool_status_from_result(result, expected):
    assert BaseAgentCallbacks._tool_status_from_result(result) == expected
