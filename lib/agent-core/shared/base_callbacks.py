# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared callbacks for agent implementations.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from .kb_types import Citation, RetrievedReference


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
        references = []
        for ref_id, ref in enumerate(self._unique_references):
            references.append(
                {
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
            )
        return references

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
