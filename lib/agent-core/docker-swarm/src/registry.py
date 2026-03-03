# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Tool and MCP Server Registry Module.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from typing import Any

# Import shared base functionality
from shared.base_registry import (
    TOOL_FACTORY_MAP,
    load_mcps_from_dynamodb,
    load_tools_from_dynamodb,
)
from shared.kb_types import RetrievalConfiguration

# Load registries at module initialization
AVAILABLE_TOOLS: dict[str, dict[str, Any]] = load_tools_from_dynamodb(TOOL_FACTORY_MAP)
AVAILABLE_MCPS: dict[str, dict[str, Any]] = load_mcps_from_dynamodb(True)


__all__ = [
    "AVAILABLE_TOOLS",
    "AVAILABLE_MCPS",
    "RetrievalConfiguration",
]
