# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import os

RETRIEVE_FROM_KB_PREFIX = "retrieve_from_kb"
INVOKE_SUBAGENT_PREFIX = "invoke_subagent"
DEFAULT_TIME_ZONE = os.environ.get("DEFAULT_TIME_ZONE", "UTC")

TOOL_DESCRIPTIONS = {
    "get_current_time": "Get the current date and time in the specified timezone. Helpful when user refers to relative time (yesterday, today, this year, now, etc.)",
    INVOKE_SUBAGENT_PREFIX: "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing",
    "get_weather_forecast": "Get the weather forecast for a city",
}
