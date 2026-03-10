# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared constants used by both docker and docker-swarm agent implementations.
# ---------------------------------------------------------------------------- #

# Prefixes for tool names
RETRIEVE_FROM_KB_PREFIX = "retrieve_from_kb"

# Tool descriptions for common tools
TOOL_DESCRIPTIONS = {
    # INVOKE_SUBAGENT_PREFIX: "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing",
}

# DynamoDB scan limit for registry loading
DYNAMODB_SCAN_LIMIT = 100
