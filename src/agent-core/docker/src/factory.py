# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import os
import tempfile
from typing import TYPE_CHECKING, Any

import boto3
from shared.base_constants import RETRIEVE_FROM_KB_PREFIX
from shared.base_factory import BaseAgentFactory
from shared.mcp_client import MCPClientManager
from strands import Agent, AgentSkills
from strands.hooks.events import (
    AfterToolCallEvent,
    BeforeToolCallEvent,
)

from .callbacks import AgentCallbacks
from .types import (
    AgentConfiguration,
    RetrievalConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger

# ── S3 skill loading ────────────────────────────────────────────────
# Skills are markdown files stored in S3 under the ``skills/`` prefix.
# Each file follows the Agent Skills spec: YAML frontmatter (name,
# description) followed by markdown instructions.
#
# To match the SDK's deterministic behaviour we download skills
# into a local temp directory using the standard ``<name>/SKILL.md``
# layout and pass the directory path to ``AgentSkills(skills=dir_path)``.
# This ensures the SDK uses the exact same code path as when loading
# skills from a local filesystem directory.

_s3_skill_client: Any | None = None


def _get_s3_skill_client():
    """Lazily create a shared boto3 S3 client for skill loading."""
    global _s3_skill_client
    if _s3_skill_client is None:
        _s3_skill_client = boto3.client("s3")
    return _s3_skill_client


def _download_skills_to_dir(
    skill_names: list[str],
    logger: Any,
) -> str | None:
    """Download skill markdown files from S3 into a local directory.

    Creates a temporary directory with the standard AgentSkills layout::

        <temp_dir>/
            analog-alarms/
                SKILL.md
            analog-io/
                SKILL.md
            ...

    This mirrors the Agent Skills spec directory structure so that
    ``AgentSkills(skills=str(dir_path))`` uses the exact same SDK code
    path as loading from a local filesystem, ensuring consistent behaviour.

    Each skill is stored in S3 at ``s3://{bucket}/skills/{name}.md``.
    Skills that fail to download are logged as warnings and skipped.

    Args:
        skill_names: List of skill names (without ``.md`` extension).
        logger: Logger instance.

    Returns:
        Path to the temporary skills directory, or None if no skills loaded.
    """
    bucket = os.environ.get("skillsBucket")
    if not bucket:
        logger.warning(
            "Cannot load skills: 'skillsBucket' environment variable not set"
        )
        return None

    s3 = _get_s3_skill_client()
    skills_dir = tempfile.mkdtemp(prefix="agent_skills_")
    loaded = 0

    for name in skill_names:
        key = f"skills/{name}.md"
        try:
            obj = s3.get_object(Bucket=bucket, Key=key)
            content = obj["Body"].read().decode("utf-8")

            # Write to <skills_dir>/<name>/SKILL.md — same layout as spec
            skill_subdir = os.path.join(skills_dir, name)
            os.makedirs(skill_subdir, exist_ok=True)
            skill_path = os.path.join(skill_subdir, "SKILL.md")
            with open(skill_path, "w", encoding="utf-8") as f:
                f.write(content)

            loaded += 1
            logger.info(
                f"Downloaded skill '{name}' from S3",
                extra={
                    "skillName": name,
                    "s3Key": key,
                    "localPath": skill_path,
                    "contentLength": len(content),
                },
            )
        except Exception as exc:
            logger.warning(
                f"Failed to download skill '{name}' from S3 — skipping",
                extra={"skillName": name, "s3Key": key, "error": str(exc)},
            )

    if loaded == 0:
        return None

    logger.info(
        f"Skills directory ready: {loaded}/{len(skill_names)} skills downloaded",
        extra={"skillsDir": skills_dir, "loadedCount": loaded},
    )
    return skills_dir


def create_agent(
    configuration: AgentConfiguration,
    logger: Logger,
    session_id: str,
    user_id: str,
    mcp_client_manager: MCPClientManager | None,
    session_manager: Any | None = None,
    trace_attributes: dict[str, str] | None = None,
    state: dict | None = None,
) -> tuple[Agent, AgentCallbacks]:
    """
    Create and configure a Strands Agent with tools, callbacks, and conversation management.

    Args:
        configuration: Agent configuration including model parameters, tools, and instructions.
        logger: Logger instance for logging agent initialization and callbacks.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        session_manager: Optional session manager for conversation state persistence.
        trace_attributes: Optional trace attributes for observability (e.g., session.id).
            Required for trajectory capture when using evaluation features.

    Returns:
        A tuple containing the configured Agent and its AgentCallbacks handler.
    """
    model = BaseAgentFactory.create_model(
        model_id=configuration.modelInferenceParameters.modelId,
        max_tokens=configuration.modelInferenceParameters.parameters.maxTokens,
        temperature=configuration.modelInferenceParameters.parameters.temperature,
        stop_sequences=configuration.modelInferenceParameters.parameters.stopSequences,
        reasoning_budget=configuration.modelInferenceParameters.reasoningBudget,
        enable_caching=True,
    )

    # ── Load skills as AgentSkills plugin ────────────────────────────
    # Download skills from S3 into a local temp directory with the
    # standard ``<name>/SKILL.md`` layout, then pass the directory path
    # to ``AgentSkills(skills=dir_path)``.  This uses the exact same
    # SDK code path as local filesystem loading for deterministic behaviour.
    plugins: list[Any] = []
    if configuration.skills:
        skills_dir = _download_skills_to_dir(configuration.skills, logger)
        if skills_dir:
            plugins.append(AgentSkills(skills=skills_dir))
            logger.info(
                "AgentSkills plugin loaded from directory",
                extra={
                    "skillsDir": skills_dir,
                    "skillCount": len(configuration.skills),
                    "skillNames": configuration.skills,
                },
            )

    agent = Agent(
        model=model,
        system_prompt=configuration.instructions,
        tools=_initialize_tools(configuration, mcp_client_manager, logger),
        callback_handler=None,
        conversation_manager=BaseAgentFactory.create_conversation_manager(
            configuration.conversationManager.value, logger
        ),
        session_manager=session_manager,
        trace_attributes=trace_attributes,
        state=state,
        plugins=plugins if plugins else None,
    )
    callbacks = AgentCallbacks(logger, session_id, user_id)

    agent.hooks.add_callback(BeforeToolCallEvent, callbacks.log_tool_entries)
    agent.hooks.add_callback(AfterToolCallEvent, callbacks.log_tool_results)

    if any([t.startswith(RETRIEVE_FROM_KB_PREFIX) for t in configuration.tools]):
        logger.info(
            "Adding callback to register into metadata the sources retrieved from the Knowledge Base"
        )
        agent.hooks.add_callback(
            AfterToolCallEvent, callbacks.retrieve_from_kb_callback
        )

    return agent, callbacks


def _initialize_custom_tools(
    agent_configuration: AgentConfiguration, logger: Logger
) -> list[Any]:
    """Initialize custom tools defined in the agent configuration.

    Uses BaseAgentFactory to initialize tools consistently.

    Args:
        agent_configuration: Agent configuration containing tool definitions and parameters.
        logger: Logger instance for logging tool initialization.

    Returns:
        List of initialized tool instances.
    """
    from .registry import AVAILABLE_TOOLS

    return BaseAgentFactory.initialize_custom_tools(
        tools_list=agent_configuration.tools,
        tool_parameters=agent_configuration.toolParameters,
        available_tools=AVAILABLE_TOOLS,
        logger=logger,
        retrieval_configuration_class=RetrievalConfiguration,
        context_name="the agent",
    )


def _initialize_tools(
    agent_configuration: AgentConfiguration,
    mcp_client_manager: MCPClientManager | None,
    logger: Logger,
) -> list[Any]:
    """
    Initialize tools from the agent configuration.

    Creates a unified list that combines MCP tools from connected MCP servers
    with custom local tools defined in the agent configuration.

    Args:
        agent_configuration: The configuration for the agent containing tool definitions.
        mcp_client_manager: Optional MCP client manager for loading MCP tools.
        logger: Logger instance for logging tool initialization.

    Returns:
        Combined list of MCP tools and custom tools.
    """
    mcp_tools: list[Any] = []
    if mcp_client_manager:
        mcp_tools = mcp_client_manager.load_mcp_tools()

    custom_tools = _initialize_custom_tools(agent_configuration, logger)

    return BaseAgentFactory.combine_tools(mcp_tools, custom_tools, logger)
