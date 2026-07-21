# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for the agentcore seeder tests."""

import os
import sys
from pathlib import Path

# Disable Powertools tracing so tests don't require the aws_xray_sdk provider,
# which is present in the Lambda runtime but not the local dev env.
os.environ.setdefault("POWERTOOLS_TRACE_DISABLED", "1")

# Env vars the seeder reads at import time. Set before `import index` so the
# module loads (and builds its boto3 resources) without a KeyError.
os.environ.setdefault("DASHBOARD_TABLE_NAME", "dashboard-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# Add the function root so `import index` resolves the module under test the
# same way the Lambda runtime does (handler = index.handler).
sys.path.insert(0, str(Path(__file__).parent.parent))
