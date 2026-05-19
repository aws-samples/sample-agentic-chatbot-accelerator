# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Registry of deterministic node functions for graph pipelines.

Deterministic nodes are pure Python functions that transform the graph
state without calling an LLM or any external service.  They are the
"reduce" half of a map-reduce pipeline (or any other stateless
transformation step).

Usage::

    from .deterministic_node_registry import (
        register_deterministic_node,
        resolve_deterministic_node,
    )

    # Registration (at import time in a states module)
    def my_merge_fn(state: dict) -> dict:
        ...
        return {"merged_template": merged, "messages": "done"}

    register_deterministic_node(
        key="my_merge_fn",
        fn=my_merge_fn,
        label="My Merge",
        description="Merges partial templates deterministically.",
    )

    # Resolution (in the factory)
    fn = resolve_deterministic_node("my_merge_fn")

Contract for registered functions
----------------------------------
* **Input** : the current LangGraph state dict (read-only in practice)
* **Output**: a dict whose keys are a *subset* of the state field names.
  LangGraph merges this partial update into the graph state.
* **No side-effects** (no LLM calls, no I/O) — deterministic means the
  same input always produces the same output.
"""

from __future__ import annotations

from typing import Any, Callable

DETERMINISTIC_NODE_REGISTRY: dict[str, Callable[[dict], dict]] = {}
DETERMINISTIC_NODE_METADATA: dict[str, dict[str, Any]] = {}


def register_deterministic_node(
    key: str,
    fn: Callable[[dict], dict],
    label: str,
    description: str = "",
) -> None:
    """Register a deterministic node function with metadata.

    Args:
        key:         Unique identifier used in the ``deterministicNodeKey``
                     config field of a :class:`GraphNodeDefinition`.
        fn:          The Python callable.  Must accept a single ``dict``
                     (the graph state) and return a ``dict`` (partial state
                     update).
        label:       Human-readable label for UI display.
        description: Longer description shown in the UI tooltip / details.
    """
    DETERMINISTIC_NODE_REGISTRY[key] = fn
    DETERMINISTIC_NODE_METADATA[key] = {
        "label": label,
        "description": description,
    }


def resolve_deterministic_node(key: str) -> Callable[[dict], dict]:
    """Resolve a registry key to its deterministic node function.

    Args:
        key: The registry key (must match a prior
             :func:`register_deterministic_node` call).

    Returns:
        The registered callable.

    Raises:
        KeyError: If the key is not found in the registry.
    """
    if key not in DETERMINISTIC_NODE_REGISTRY:
        available = list(DETERMINISTIC_NODE_REGISTRY.keys())
        raise KeyError(
            f"Deterministic node '{key}' not found in registry. "
            f"Available: {available}"
        )
    return DETERMINISTIC_NODE_REGISTRY[key]


def list_deterministic_nodes() -> list[dict[str, Any]]:
    """Return metadata for all registered deterministic nodes.

    Intended to be consumed by the UI/API to populate a dropdown of
    available deterministic node functions.

    Returns:
        A list of dicts, each containing ``key``, ``label``, and
        ``description``.
    """
    return [{"key": k, **v} for k, v in DETERMINISTIC_NODE_METADATA.items()]
