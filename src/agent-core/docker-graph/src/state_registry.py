# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Registry of predefined state classes for complex graph pipelines.

Simple graphs use the flat ``stateSchema`` (``dict[str, str]``) built
dynamically by :func:`factory._build_state_type`.  Complex pipelines
register their ``TypedDict`` state classes here, making them selectable
from the UI via the ``stateClass`` configuration field.

Usage::

    from .state_registry import register_state_class, resolve_state_class

    # Registration (at import time in a states module)
    register_state_class(
        key="MyPipelineState",
        cls=MyPipelineState,
        label="My Pipeline",
        description="Description of the pipeline state.",
    )

    # Resolution (in the factory)
    state_type = resolve_state_class("MyPipelineState")
"""

from __future__ import annotations

STATE_CLASS_REGISTRY: dict[str, type] = {}
STATE_CLASS_METADATA: dict[str, dict] = {}


def register_state_class(
    key: str,
    cls: type,
    label: str,
    description: str = "",
    fields: list[str] | None = None,
) -> None:
    """Register a state class with metadata for UI discovery.

    Args:
        key: Unique identifier used in the ``stateClass`` config field.
        cls: The ``TypedDict`` (or similar) class to use as LangGraph state.
        label: Human-readable label for UI display.
        description: Longer description shown in the UI tooltip / details.
        fields: Optional explicit field list.  Defaults to the class annotations.
    """
    STATE_CLASS_REGISTRY[key] = cls
    STATE_CLASS_METADATA[key] = {
        "label": label,
        "description": description,
        "fields": fields or list(getattr(cls, "__annotations__", {}).keys()),
    }


def resolve_state_class(key: str) -> type:
    """Resolve a registry key to its state class.

    Args:
        key: The registry key (must match a prior ``register_state_class`` call).

    Returns:
        The registered state class.

    Raises:
        KeyError: If the key is not found in the registry.
    """
    if key not in STATE_CLASS_REGISTRY:
        available = list(STATE_CLASS_REGISTRY.keys())
        raise KeyError(
            f"State class '{key}' not found in registry. " f"Available: {available}"
        )
    return STATE_CLASS_REGISTRY[key]


def list_state_classes() -> list[dict]:
    """Return metadata for all registered state classes.

    Intended to be consumed by the UI/API to populate a dropdown of
    predefined state schemas alongside the "Custom" flat-field option.

    Returns:
        A list of dicts, each containing ``key``, ``label``,
        ``description``, and ``fields``.
    """
    return [{"key": k, **v} for k, v in STATE_CLASS_METADATA.items()]
