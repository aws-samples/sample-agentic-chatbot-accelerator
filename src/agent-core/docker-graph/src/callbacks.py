# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from shared.base_callbacks import BaseAgentCallbacks
from strands.hooks.events import (
    AfterToolCallEvent,
    BeforeToolCallEvent,
)


class GraphCallbacks(BaseAgentCallbacks):
    """Callbacks for graph agent operations including tool invocations and node lifecycle."""

    def log_node_entry(self, node_id: str, agent_name: str) -> None:
        """Log entry into a graph node.

        Args:
            node_id (str): The unique identifier of the graph node being entered.
            agent_name (str): The name of the agent referenced by this node.
        """
        self._logger.info(
            f"Entering graph node '{node_id}' (agent: '{agent_name}')",
            extra={"nodeId": node_id, "agentName": agent_name},
        )

    def log_node_exit(self, node_id: str, agent_name: str) -> None:
        """Log exit from a graph node.

        Args:
            node_id (str): The unique identifier of the graph node being exited.
            agent_name (str): The name of the agent referenced by this node.
        """
        self._logger.info(
            f"Exiting graph node '{node_id}' (agent: '{agent_name}')",
            extra={"nodeId": node_id, "agentName": agent_name},
        )

    def log_tool_entries(self, event: BeforeToolCallEvent) -> None:
        """Log information about a tool invocation before it occurs.

        Args:
            event (BeforeToolCallEvent): Event containing metadata about the tool to be invoked.
        """
        specs = event.selected_tool.tool_spec if event.selected_tool else None

        self._nb_tool_invocations += 1

        self._logger.info(
            f"Agent is going to call tool #{self._nb_tool_invocations} in this turn",
            extra={"toolSpecifications": specs, "toolParameters": event.tool_use},
        )

        parameters = self._extract_tool_parameters(event, specs)

        tool_name = event.tool_use.get("name", "unknown")
        tool_description = specs.get("description", "") if specs else ""
        self._publish_tool_invocation(tool_name, tool_description, parameters)

    def log_tool_results(self, event: AfterToolCallEvent) -> None:
        """Log tool results after execution.

        Args:
            event (AfterToolCallEvent): Event containing tool results.
        """
        if event.selected_tool:
            self._logger.info(
                "The tool returned a response",
                extra={
                    "payload": {
                        "toolName": event.selected_tool.tool_name,
                        "result": event.result,
                    }
                },
            )
