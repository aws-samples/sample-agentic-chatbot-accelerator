# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
# TODO: Remove code duplication - consider moving shared code to a common module
import os

RETRIEVE_FROM_KB_PREFIX = "retrieve_from_kb"
INVOKE_SUBAGENT_PREFIX = "invoke_subagent"
DEFAULT_TIME_ZONE = os.environ.get("DEFAULT_TIME_ZONE", "UTC")

TOOL_DESCRIPTIONS = {
    "get_current_time": "Get the current date and time in the specified timezone. Helpful when user refers to relative time (yesterday, today, this year, now, etc.)",
    INVOKE_SUBAGENT_PREFIX: "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing",
    "get_weather_forecast": "Get the weather forecast for a city",
}

# Default swarm orchestration settings
DEFAULT_MAX_HANDOFFS = 20
DEFAULT_MAX_ITERATIONS = 20
DEFAULT_EXECUTION_TIMEOUT = 900.0  # 15 minutes
DEFAULT_NODE_TIMEOUT = 300.0  # 5 minutes per agent
DEFAULT_REPETITIVE_HANDOFF_DETECTION_WINDOW = 8
DEFAULT_REPETITIVE_HANDOFF_MIN_UNIQUE_AGENTS = 3
