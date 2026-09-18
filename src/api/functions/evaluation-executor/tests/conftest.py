# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for the evaluation-executor tests."""

import sys
from pathlib import Path

_FUNCTION_DIR = Path(__file__).parent.parent

# The function directory so `import evaluator` resolves as it does in the Lambda,
# and the agent-core root ahead of it so `shared.*` resolves to the editable
# source rather than the generated bundle copy (gitignored, and absent until a
# deploy has run `make copy-model-routing`).
sys.path.insert(0, str(_FUNCTION_DIR))
sys.path.insert(0, str(_FUNCTION_DIR.parents[2] / "agent-core"))
