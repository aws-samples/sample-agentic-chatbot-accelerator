# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared callbacks for agent implementations.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from .base_constants import RETRIEVE_FROM_KB_PREFIX
from .kb_types import Citation, RetrievedReference

if TYPE_CHECKING:
    from concurrent.futures import Future
    from logging import Logger

# Max characters of a single tool-argument value forwarded to the browser. Tool
# inputs can be large (pasted documents, encoded blobs); the UI only needs a
# preview, and oversized payloads bloat the WS frame and the persisted record.
_MAX_TOOL_ARG_VALUE_CHARS = 200


class FormatCitations:
    """A class for formatting citations and references from knowledge base responses.

    This class processes citation information from knowledge base responses and formats them
    into standardized reference and citation objects for display or further processing.

    Attributes:
        _citations (Sequence[Citation]): The sequence of Citation objects to process
        _unique_references (Sequence[RetrievedReference]): Deduplicated list of references

    Args:
        citations (Sequence[Citation]): The sequence of Citation objects to format
    """

    def __init__(self, citations: list[Citation]):
        self._citations = citations
        self._unique_references: list[
            RetrievedReference
        ] = self._get_unique_references()

    def _get_unique_references(self):
        unique_references = set()
        for cit in self._citations:
            retrieved_reference = cit.retrievedReferences
            for ref in retrieved_reference:
                unique_references.add(ref)
        return list(unique_references)

    @staticmethod
    def format_reference_dict(ref: RetrievedReference, ref_id: int) -> dict:
        """Format a single reference into a dictionary.

        Args:
            ref (RetrievedReference): The reference to format
            ref_id (int): The reference ID (0-based, will be converted to 1-based)

        Returns:
            dict: Formatted reference dictionary with all required fields
        """
        return {
            "referenceId": str(ref_id + 1),
            "uri": ref.location.get_id(),
            "pageNumber": str(ref.get_page_number()),
            "content": ref.content.get_content(),
            "documentTitle": (
                ".".join(ref.metadata["documentName"].split(".")[:-1])  # type: ignore
                if "documentName" in ref.metadata
                else ref.location.get_id()
            ),
        }

    def get_references(self) -> list[dict]:
        """Get formatted references from the unique references.

        Returns:
            Sequence[Dict]: A list of dictionaries containing formatted reference information.
            Each dictionary has the following keys:
                - referenceId (str): Unique identifier for the reference
                - uri (str): URI location of the referenced document
                - pageNumber (str): Page number where the reference appears
                - content (str): The referenced content
                - documentTitle (str): Title of the source document
        """
        return [
            self.format_reference_dict(ref, ref_id)
            for ref_id, ref in enumerate(self._unique_references)
        ]

    def get_formatted_citations(self) -> list[dict]:
        """Get formatted citations with reference IDs and locations.

        Returns:
            Sequence[Dict]: A list of dictionaries containing formatted citation information.
            Each dictionary has the following keys:
                - referenceId (int): ID of the reference (1-based index)
                - location (int): End position of the citation in the response text

        Note:
            Citations are sorted by referenceId before being returned.
        """
        formatted_citations = []
        for cit in self._citations:
            if not cit.generatedResponsePart:
                continue
            response_part = cit.generatedResponsePart.textResponsePart
            for ref in cit.retrievedReferences:
                formatted_citations.append(
                    {
                        "referenceId": self._unique_references.index(ref) + 1,
                        "location": response_part.span.end,
                    }
                )
        return sorted(
            formatted_citations, key=lambda x: (x["location"], x["referenceId"])
        )


class BaseAgentCallbacks:
    """Base class for agent callback handlers.

    This class provides common callback handlers for agent operations including
    tool invocations and knowledge base retrievals. It manages metadata collection
    and logging during agent execution.

    Subclasses can override methods to customize behavior for specific agent types.

    Attributes:
        _metadata (dict): Dictionary storing metadata generated by tools, e.g. Knowledge base references.
        _logger (Logger): Logger instance for recording agent operations and tool usage.
        _nb_tool_invocations (int): Counter for the number of tool invocations in current turn.
        _session_id (str): Current session identifier.
        _user_id (str): Current user identifier.
        _websocket: Optional WebSocket reference for direct tool action delivery.
    """

    def __init__(self, logger: Logger, session_id: str, user_id: str) -> None:
        """Initialize the base agent callbacks.

        Args:
            logger (Logger): Logger instance for recording operations
            session_id (str): Session identifier
            user_id (str): User identifier
        """
        self._metadata = dict()
        self._logger = logger
        self._nb_tool_invocations = 0
        self._session_id = session_id
        self._user_id = user_id
        self._websocket = None  # Optional WebSocket for direct tool action delivery
        # Event loop that owns the WebSocket, captured at attach time. Tool
        # callbacks can fire on worker threads (Strands runs tools off the loop),
        # so sends are dispatched back to this loop via run_coroutine_threadsafe.
        self._ws_loop: asyncio.AbstractEventLoop | None = None

    def attach_websocket(self, websocket) -> None:
        """Attach the browser WebSocket and capture its running event loop.

        Must be called from a coroutine running on the WebSocket's event loop
        (i.e. inside the ``/ws`` handler) so the correct loop is captured.
        Subsequent tool-step sends are scheduled onto this loop even when the
        callback fires from a worker thread.

        Args:
            websocket: The FastAPI/Starlette WebSocket for the current session.
        """
        self._websocket = websocket
        try:
            self._ws_loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop (shouldn't happen from the WS handler) — fall back
            # to best-effort scheduling in _send_ws_event.
            self._ws_loop = None

    @property
    def metadata(self) -> dict:
        """Get the current metadata dictionary."""
        return self._metadata

    def reset_metadata(self) -> None:
        """Reset metadata and tool invocation counter."""
        self._metadata = dict()
        self._nb_tool_invocations = 0

    def _extract_tool_parameters(self, event, specs) -> list[dict]:
        """Extract and format tool parameters from event.

        Args:
            event: Tool call event containing tool_use information
            specs: Tool specifications containing input schema

        Returns:
            list[dict]: List of parameter dictionaries with name, type, description, value
        """
        parameters = []
        input_values = event.tool_use.get("input", {})

        if specs:
            input_schema = specs.get("inputSchema", {}).get("json", {})
            properties = input_schema.get("properties", {})

            for param_name, param_value in input_values.items():
                param_schema = properties.get(param_name, {})
                parameters.append(
                    {
                        "name": param_name,
                        "type": param_schema.get("type", "unknown"),
                        "description": param_schema.get("description", ""),
                        "value": param_value,
                    }
                )
        else:
            # Fallback if no specs available
            for param_name, param_value in input_values.items():
                parameters.append(
                    {
                        "name": param_name,
                        "type": "unknown",
                        "description": "",
                        "value": param_value,
                    }
                )

        return parameters

    def _send_ws_event(self, payload: dict) -> None:
        """Schedule a JSON payload on the browser-facing WebSocket.

        Tool callbacks fire from synchronous Strands hooks that may run on a
        worker thread (e.g. swarm node execution), not the WebSocket's event
        loop. Dispatching via ``run_coroutine_threadsafe`` onto the loop captured
        in ``attach_websocket`` schedules the send AND wakes the loop, so frames
        flush immediately instead of waiting for the loop to next cycle. A no-op
        when no WebSocket is attached (e.g. the ``/invocations`` SSE path). Never
        raises into the agent run — failures are logged.

        Args:
            payload (dict): JSON-serializable event to send to the browser.
        """
        if self._websocket is None:
            return

        try:
            coro = self._websocket.send_json(payload)
            if self._ws_loop is not None:
                # Schedule onto the WS loop from any thread and wake it now.
                # run_coroutine_threadsafe runs the send on the loop, so a failure
                # there (e.g. the socket closed) lands in the Future, not this
                # try/except — log it via a done-callback to honour the docstring.
                future = asyncio.run_coroutine_threadsafe(coro, self._ws_loop)
                future.add_done_callback(self._log_send_failure)
            else:
                # Fallback: no captured loop (attach_websocket not used).
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    asyncio.ensure_future(coro)
                else:
                    loop.run_until_complete(coro)
        except Exception as ws_err:
            self._logger.warning(f"Failed to send WebSocket event: {ws_err}")

    def _log_send_failure(self, future: Future) -> None:
        """Surface an exception raised inside a threadsafe-scheduled send."""
        try:
            future.result()
        except Exception as ws_err:
            self._logger.warning(f"Failed to send WebSocket event: {ws_err}")

    @staticmethod
    def _format_arg_value(value) -> str:
        """Render a tool-argument value as a compact, length-capped string.

        Non-string values are JSON-encoded so structured args (lists, dicts)
        stay readable in the UI. Anything longer than
        ``_MAX_TOOL_ARG_VALUE_CHARS`` is truncated with an ellipsis — the UI
        shows a preview, not the full payload.

        Args:
            value: The raw argument value from the tool input.

        Returns:
            str: A display-ready, truncated representation.
        """
        if isinstance(value, str):
            text = value
        else:
            try:
                text = json.dumps(value, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                text = str(value)
        if len(text) > _MAX_TOOL_ARG_VALUE_CHARS:
            text = text[:_MAX_TOOL_ARG_VALUE_CHARS] + "…"
        return text

    def _send_tool_action(
        self, tool_name: str, tool_description: str, parameters: list[dict]
    ) -> None:
        """Emit a ``tool_action`` event over the browser WebSocket.

        Args:
            tool_name (str): Name of the tool being invoked.
            tool_description (str): Static spec description (may be empty).
            parameters (list[dict]): Parameter dicts with ``name`` and ``value``;
                both are forwarded (values length-capped) so the UI can show what
                the agent passed.
        """
        self._send_ws_event(
            {
                "type": "tool_action",
                "toolName": tool_name,
                "description": tool_description,
                "parameters": [
                    {"name": p["name"], "value": self._format_arg_value(p["value"])}
                    for p in parameters
                ],
                "invocationNumber": self._nb_tool_invocations,
            }
        )

    def _send_tool_complete(
        self, tool_name: str, invocation_number: int, status: str = "success"
    ) -> None:
        """Emit a ``tool_complete`` event over the browser WebSocket.

        The payload is intentionally minimal (no result content) so large or
        sensitive tool output never reaches the UI — results flow via
        ``final_response``.

        Args:
            tool_name (str): Name of the tool that finished.
            invocation_number (int): Must match the paired ``tool_action`` so the
                frontend can correlate.
            status (str): ``"success"`` or ``"error"``.
        """
        self._send_ws_event(
            {
                "type": "tool_complete",
                "toolName": tool_name,
                "invocationNumber": invocation_number,
                "status": status,
            }
        )

    @staticmethod
    def _tool_status_from_result(result) -> str:
        """Derive ``tool_complete`` status from a Strands tool result.

        Strands tool results are dicts shaped ``{"status": "success"|"error", ...}``.
        Defaults to ``"success"`` when the shape is unknown.

        Args:
            result: The tool result from an ``AfterToolCallEvent``.

        Returns:
            str: ``"error"`` if the result reports an error, else ``"success"``.
        """
        if isinstance(result, dict) and result.get("status") == "error":
            return "error"
        return "success"

    def retrieve_from_kb_callback(self, event) -> None:
        """Callback handler for knowledge base retrieval operations.

        Processes retrieval results from knowledge base queries, formats citations,
        and updates metadata with references.

        Args:
            event: Event containing tool invocation results and metadata.

        Returns:
            None
        """
        if event.selected_tool and event.selected_tool.tool_name.startswith(
            RETRIEVE_FROM_KB_PREFIX
        ):
            sources = event.result.get("content", [{}])[0].get("json", {}).get("retrievalResults", [])  # type: ignore
            if not sources:
                # No sources found --> return
                return

            citations = Citation(
                retrievedReferences=[
                    RetrievedReference.model_validate(s) for s in sources
                ]
            )
            formatter = FormatCitations([citations])

            # Get existing unique references (RetrievedReference objects)
            existing_unique_refs = self._metadata.get("_unique_references", [])

            # Combine with new ones using set to deduplicate (leveraging __hash__ and __eq__)
            all_unique_refs = list(
                set(existing_unique_refs + list(formatter._unique_references))
            )

            # Store the unique references for future deduplication
            self._metadata["_unique_references"] = all_unique_refs

            # Format references with sequential IDs using the static helper
            references = [
                FormatCitations.format_reference_dict(ref, ref_id)
                for ref_id, ref in enumerate(all_unique_refs)
            ]

            self._metadata["references"] = references
