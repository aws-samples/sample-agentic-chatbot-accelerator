# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Pytest configuration for the port-config-to-bundles script tests."""

import sys
from pathlib import Path

# Add the scripts root so `import port_config_to_bundles` resolves the module
# under test (it is a standalone operator script, not a Lambda handler).
sys.path.insert(0, str(Path(__file__).parent.parent))
