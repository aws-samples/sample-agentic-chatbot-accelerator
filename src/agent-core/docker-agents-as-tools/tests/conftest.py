# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for agents-as-tools tests."""

import sys
from pathlib import Path

# Add the image root to sys.path so `import src.*` resolves the same way the
# container does (src/ is copied to the image root).
sys.path.insert(0, str(Path(__file__).parent.parent))
