# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for the create-runtime-version Lambda tests."""

import os
import sys
from pathlib import Path

# Disable Powertools tracing so tests don't require the aws_xray_sdk provider,
# which is present in the Lambda runtime but not the local dev env.
os.environ.setdefault("POWERTOOLS_TRACE_DISABLED", "1")

# Module-level env vars the Lambda reads at import time. Set them before
# `import index` so the module loads without a KeyError.
os.environ.setdefault(
    "CONTAINER_URI", "123.dkr.ecr.us-east-1.amazonaws.com/single:latest"
)
os.environ.setdefault(
    "AGENT_CORE_RUNTIME_ROLE_ARN", "arn:aws:iam::123456789012:role/runtime"
)
os.environ.setdefault("AGENT_CORE_RUNTIME_TABLE", "runtime-table")
os.environ.setdefault("TOOL_REGISTRY_TABLE", "tool-registry")
os.environ.setdefault("MCP_SERVER_REGISTRY_TABLE", "mcp-registry")
os.environ.setdefault("ACCOUNT_ID", "123456789012")

_FUNCTION_ROOT = Path(__file__).parent.parent
# Add the function root so `import index` resolves the module under test the
# same way the Lambda runtime does (handler = index.handler).
sys.path.insert(0, str(_FUNCTION_ROOT))
# The genai_core package is vendored into the function dir at build time (empty
# in the repo); point at the shared python-sdk layer so imports resolve locally.
sys.path.insert(0, str(_FUNCTION_ROOT.parents[2] / "shared" / "layers" / "python-sdk"))
