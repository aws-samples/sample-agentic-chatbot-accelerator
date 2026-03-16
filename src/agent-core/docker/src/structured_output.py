# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Dynamic Pydantic model creation for structured agent output.

This module builds a Pydantic BaseModel at runtime from a list of field
specifications (name, python_type, description) provided in the agent
configuration.  The resulting model can be passed as
``structured_output_model`` to the Strands Agent so the LLM response is
automatically parsed and validated.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, create_model

from .types import StructuredOutputFieldSpec

# ── Supported type mapping ------------------------------------------------- #
# Only safe, primitive / shallow-generic types are allowed.  Extending this
# dict is the single place to add new supported types.

_TYPE_MAP: dict[str, type[Any]] = {
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "list[str]": list[str],
    "list[int]": list[int],
    "list[float]": list[float],
    "dict": dict,
}


def _resolve_type(type_str: str) -> type[Any]:
    """Resolve a type string to an actual Python type.

    Args:
        type_str: A string representation of the type (e.g. ``"str"``, ``"list[int]"``).

    Returns:
        The corresponding Python type.

    Raises:
        ValueError: If ``type_str`` is not in the supported type map.
    """
    resolved = _TYPE_MAP.get(type_str)
    if resolved is None:
        supported = ", ".join(sorted(_TYPE_MAP.keys()))
        raise ValueError(
            f"Unsupported python_type '{type_str}'. Supported types: {supported}"
        )
    return resolved


def build_structured_output_model(
    fields: list[StructuredOutputFieldSpec],
    model_name: str = "AgentStructuredOutput",
) -> type[BaseModel]:
    """Create a Pydantic model dynamically from field specifications.

    This mirrors what a developer would write by hand, e.g.::

        class DiagramInfo(BaseModel):
            loop_id: str = Field(description="The canonical loop identifier")
            ...

    but builds it at runtime from the agent configuration stored in DynamoDB.

    Args:
        fields: List of field specifications from the agent configuration.
        model_name: Name for the generated Pydantic model class.

    Returns:
        A dynamically-created Pydantic ``BaseModel`` subclass.

    Raises:
        ValueError: If ``fields`` is empty or contains unsupported types.
    """
    if not fields:
        raise ValueError(
            "At least one field is required to build a structured output model"
        )

    field_definitions: dict[str, Any] = {}
    for spec in fields:
        python_type = _resolve_type(spec.pythonType)
        if spec.optional:
            field_definitions[spec.name] = (
                Optional[python_type],
                Field(default=None, description=spec.description),
            )
        else:
            field_definitions[spec.name] = (
                python_type,
                Field(description=spec.description),
            )

    return create_model(model_name, **field_definitions)  # type: ignore[call-overload]
