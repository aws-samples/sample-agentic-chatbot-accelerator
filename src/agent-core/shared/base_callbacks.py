# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared callbacks for agent implementations.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import boto3
from botocore.exceptions import ClientError

from .base_constants import RETRIEVE_FROM_KB_PREFIX
from .kb_types import Citation, RetrievedReference

if TYPE_CHECKING:
    from logging import Logger

# --------------------------- AWS CLIENTS ---------------------------- #
SNS_CLIENT = boto3.client("sns", region_name=os.environ.get("AWS_REGION"))
AGENT_TOOLS_TOPIC_ARN = os.environ.get("agentToolsTopicArn", "")
# -------------------------------------------------------------------- #


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

    def _publish_tool_invocation(
        self, tool_name: str, tool_description: str, parameters: list[dict]
    ) -> None:
        """Publish tool invocation message to SNS topic.

        Args:
            tool_name (str): Name of the tool being invoked
            tool_description (str): Description of the tool
            parameters (list[dict]): List of tool parameters
        """
        message = {
            "context": {
                "userId": self._user_id,
                "sessionId": self._session_id,
                "invocationNumber": self._nb_tool_invocations,
            },
            "data": {
                "toolName": tool_name,
                "toolDescription": tool_description,
                "parameters": parameters,
            },
        }

        if AGENT_TOOLS_TOPIC_ARN:
            try:
                SNS_CLIENT.publish(
                    TopicArn=AGENT_TOOLS_TOPIC_ARN,
                    Message=json.dumps(message),
                    Subject="AgentToolInvocation",
                )
                self._logger.info(
                    "Published tool invocation to SNS",
                    extra={
                        "topicArn": AGENT_TOOLS_TOPIC_ARN,
                        "toolName": tool_name,
                    },
                )
            except (ClientError, ValueError) as err:
                self._logger.warning(
                    "Failed to publish tool invocation to SNS",
                    extra={"error": str(err)},
                )

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
