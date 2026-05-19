# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
"""Predefined state classes for complex graph pipelines.

Each module in this package defines one or more ``TypedDict`` state classes
and registers them with the :mod:`state_registry` at import time.

Importing this package triggers registration of all predefined states,
making them available for resolution via ``stateClass`` in the graph
configuration.

To add a new predefined state class:
1. Create a new module in this package (e.g., ``my_pipeline.py``)
2. Define your TypedDict state class with Annotated reducers as needed
3. Call ``register_state_class(...)`` at module level
4. Import the module here to trigger registration
"""
