# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Custom A2A executor that surfaces Strands structured output as a DataPart.

The stock ``StrandsA2AExecutor`` only emits ``TextPart`` artifacts, which means
graph nodes calling sub-agents over A2A would lose their structured output —
the field a graph relies on to merge sub-agent results into shared state.

This executor subclasses Strands' implementation and:

1. Receives an optional ``structured_output_model`` at construction time and
   threads it through ``stream_async`` so the agent will produce one.
2. Adds a ``DataPart`` containing the structured output's JSON to the final
   artifact, alongside the existing ``TextPart``.

Used only by sub-agent containers running in A2A protocol mode that declare a
``structuredOutput`` in their config.
"""
from __future__ import annotations

import logging
from typing import Any

from a2a.server.agent_execution import RequestContext
from a2a.server.tasks import TaskUpdater
from a2a.types import DataPart, Part, TextPart
from pydantic import BaseModel
from strands.agent.agent import Agent as SAAgent
from strands.agent.agent import AgentResult as SAAgentResult
from strands.multiagent.a2a.executor import StrandsA2AExecutor

logger = logging.getLogger(__name__)


class StructuredOutputA2AExecutor(StrandsA2AExecutor):
    """A2A executor that requests structured output and ships it as a DataPart.

    Behaves identically to ``StrandsA2AExecutor`` when ``structured_output_model``
    is None — it only diverges when a structured output is configured.
    """

    def __init__(
        self,
        agent: SAAgent,
        structured_output_model: type[BaseModel] | None = None,
        *,
        enable_a2a_compliant_streaming: bool = False,
    ):
        super().__init__(
            agent, enable_a2a_compliant_streaming=enable_a2a_compliant_streaming
        )
        self._structured_output_model = structured_output_model

    async def _execute_streaming(
        self, context: RequestContext, updater: TaskUpdater
    ) -> None:
        """Stream the agent run with the configured structured output model.

        Mirrors the parent implementation but passes ``structured_output_model``
        into ``stream_async``. Without this, the resulting ``AgentResult`` has
        no ``structured_output`` and the DataPart we emit on completion would
        be empty — defeating the whole point of this subclass.
        """
        if not (context.message and getattr(context.message, "parts", None)):
            raise ValueError("No content blocks available")

        content_blocks = self._convert_a2a_parts_to_content_blocks(
            context.message.parts
        )
        if not content_blocks:
            raise ValueError("No content blocks available")

        invocation_state: dict[str, Any] = {"a2a_request_context": context}

        stream_kwargs: dict[str, Any] = {"invocation_state": invocation_state}
        if self._structured_output_model is not None:
            stream_kwargs["structured_output_model"] = self._structured_output_model

        try:
            async for event in self.agent.stream_async(content_blocks, **stream_kwargs):
                await self._handle_streaming_event(event, updater)
        except Exception:
            logger.exception("Error in streaming execution")
            raise

    async def _handle_agent_result(
        self, result: SAAgentResult | None, updater: TaskUpdater
    ) -> None:
        """Emit the final artifact, attaching structured output as a DataPart.

        Strands' base executor only writes a ``TextPart`` artifact named
        ``agent_response``. We append a sibling ``DataPart`` carrying the
        Pydantic dump of ``result.structured_output`` so A2A clients can
        recover the structured payload without re-parsing the prose.
        """
        # Build the parts list for this artifact
        text = str(result) if result else ""
        parts: list[Part] = [Part(root=TextPart(text=text))]

        structured: dict[str, Any] | None = None
        if result is not None:
            so = getattr(result, "structured_output", None)
            if so is not None:
                try:
                    structured = (
                        so.model_dump() if hasattr(so, "model_dump") else dict(so)
                    )
                    parts.append(Part(root=DataPart(data=structured)))
                except Exception:
                    logger.exception("Failed to serialize structured output")

        if self.enable_a2a_compliant_streaming:
            await updater.add_artifact(
                parts,
                artifact_id=self._current_artifact_id,
                name="agent_response",
                last_chunk=True,
                append=not self._is_first_chunk,
            )
        else:
            # Legacy mode mirrors parent: only attach an artifact when there
            # is content. Skipping no-content artifacts keeps the response
            # quiet for tool-only completions.
            if text or structured:
                await updater.add_artifact(parts, name="agent_response")
        await updater.complete()
