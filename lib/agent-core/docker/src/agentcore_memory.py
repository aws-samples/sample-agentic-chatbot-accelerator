# -----------------------------------------------------------------------
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# -----------------------------------------------------------------------
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)


def create_session_manager(
    memory_id: str, session_id: str, user_id: str, region_name: Optional[str]
) -> AgentCoreMemorySessionManager:
    """Create and configure an AgentCore memory session manager.

    Args:
        memory_id (str): Unique identifier for the memory instance
        session_id (str): Unique identifier for the conversation session
        user_id (str): Unique identifier for the user/actor
        region_name (Optional[str]): AWS region name for the session manager

    Returns:
        AgentCoreMemorySessionManager: Configured session manager instance
    """
    agentcore_memory_config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=user_id,
    )

    session_manager = AgentCoreMemorySessionManager(
        agentcore_memory_config=agentcore_memory_config,
        region_name=region_name,
    )
    return session_manager
