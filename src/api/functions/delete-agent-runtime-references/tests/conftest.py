# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for the delete-agent-runtime-references Lambda tests."""

import os
import sys
from pathlib import Path

# Disable Powertools tracing so tests don't require the aws_xray_sdk provider,
# which is present in the Lambda runtime but not the local dev env.
os.environ.setdefault("POWERTOOLS_TRACE_DISABLED", "1")

# Add the function root to sys.path so `import index` resolves the module under
# test the same way the Lambda runtime does (handler = index.handler).
sys.path.insert(0, str(Path(__file__).parent.parent))
