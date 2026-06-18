# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for shared agent-core tests."""

import sys
from pathlib import Path

# Add the agent-core root to the path so `import shared.*` resolves the same way
# it does inside the containers (where `shared/` is copied to the image root).
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
