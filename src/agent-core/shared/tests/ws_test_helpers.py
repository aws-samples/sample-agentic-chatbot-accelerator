# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Shared fakes for the per-container tool-step WebSocket tests.

Each agent container has its own `src` package, so we load each container's
`callbacks.py` by file path under a unique module name to avoid the `src`
package-name collision when the suites run together. The container callbacks
only import `shared.*` and `strands.*` (no intra-package imports), so loading
the file directly works.
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace

# Agent-core root: .../src/agent-core
AGENT_CORE_ROOT = Path(__file__).resolve().parent.parent.parent


def load_agent_callbacks(container: str):
    """Load `<container>/src/callbacks.py` as a uniquely-named module.

    Args:
        container: Directory name under agent-core (e.g. "docker", "docker-swarm").

    Returns:
        The module's `AgentCallbacks` class.
    """
    path = AGENT_CORE_ROOT / container / "src" / "callbacks.py"
    mod_name = f"_callbacks_{container.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.AgentCallbacks


class FakeWebSocket:
    """Captures payloads sent to send_json (async, as FastAPI's WebSocket is)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    def events(self, event_type: str) -> list[dict]:
        return [p for p in self.sent if p.get("type") == event_type]


class FakeSelectedTool:
    def __init__(self, tool_name: str, tool_spec: dict | None) -> None:
        self.tool_name = tool_name
        self.tool_spec = tool_spec


def make_before_event(
    tool_name: str, tool_use_id: str, tool_input: dict, spec_description: str = ""
):
    """Build a stand-in BeforeToolCallEvent (attribute access only)."""
    tool_spec = {
        "description": spec_description,
        "inputSchema": {
            "json": {"properties": {k: {"type": "string"} for k in tool_input}}
        },
    }
    return SimpleNamespace(
        selected_tool=FakeSelectedTool(tool_name, tool_spec),
        tool_use={"name": tool_name, "toolUseId": tool_use_id, "input": tool_input},
    )


def make_after_event(tool_name: str, tool_use_id: str, result: dict):
    """Build a stand-in AfterToolCallEvent."""
    return SimpleNamespace(
        selected_tool=FakeSelectedTool(tool_name, None),
        tool_use={"name": tool_name, "toolUseId": tool_use_id},
        result=result,
    )


def make_callbacks(container: str):
    """Instantiate a container's AgentCallbacks with a real logger."""
    cls = load_agent_callbacks(container)
    return cls(logging.getLogger("test"), "session-1", "user-1")
