# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

import json
import os
import uuid
from typing import Any

from botocore.exceptions import ClientError
from shared.base_registry import (
    TOOL_FACTORY_MAP,
    AbstractToolObject,
    get_agentcore_client,
    load_mcps_from_dynamodb,
    load_tools_from_dynamodb,
)
from shared.kb_types import RetrievalConfiguration
from shared.utils import parse_agent_runtime_response
from strands import ToolContext

# -------------------------------------------------------------------- #
# Environment variables
# -------------------------------------------------------------------- #
ACCOUNT_ID = os.environ.get("accountId")
REGION_NAME = os.environ.get("AWS_REGION")

# -------------------------------------------------------------------- #
AVAILABLE_TOOLS: dict[str, dict[str, Any]] = load_tools_from_dynamodb(TOOL_FACTORY_MAP)
AVAILABLE_MCPS: dict[str, dict[str, Any]] = load_mcps_from_dynamodb(True)


class InvokeSubAgentTool(AbstractToolObject):
    """A tool for invoking sub-agents to process specialized tasks.

    This class enables delegation of specific queries to specialized sub-agents hosted on Amazon Bedrock AgentCore.

    Args:
        agent_runtime (str): The name identifier of the sub-agent
        agent_role (str): Description of the sub-agent's role and capabilities
        qualifier (str, optional): Agent version qualifier. Defaults to "DEFAULT"
    """

    __subagent_prefix__ = "invoke"

    def __init__(
        self,
        agent_runtime: str,
        agent_role: str,
        qualifier: str = "DEFAULT",
    ) -> None:
        self._agent_runtime_id = agent_runtime
        self._qualifier = qualifier

        tool_schema = {
            "json": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Prompt from the orchestrator used to invoke sub-agent. Make sure to formulate the query based on the agent role description.",
                    },
                },
                "required": ["query"],
            }
        }

        super().__init__(
            description=(
                "Complete, self-contained prompt to send to the sub-agent. "
                "IMPORTANT: You MUST include ALL relevant details, parameters, "
                "and data from the user's request that the sub-agent needs to "
                "fulfill its role. The sub-agent has NO access to the conversation "
                "history — if you omit information, it will be lost. "
                f"The sub-agent role is: {agent_role}"
            ),
            name=f"{self.__subagent_prefix__}_{agent_runtime}",
            schema=tool_schema,
            context=True,
            is_async=True,
        )

    def _tool_implementation(self, query: str, tool_context: ToolContext) -> str:
        """Invokes a sub-agent to process the given query."""
        ac_client = get_agentcore_client()
        user_id = tool_context.invocation_state.get("userId", "default")
        session_id = tool_context.invocation_state.get("sessionId", str(uuid.uuid4()))
        session_id += f"-sa-{self._agent_runtime_id}"

        runtime_arn = f"arn:aws:bedrock-agentcore:{REGION_NAME}:{ACCOUNT_ID}:runtime/{self._agent_runtime_id}"

        try:
            payload = json.dumps(
                {
                    "prompt": query,
                    "userId": user_id,
                }
            ).encode()

            response = ac_client.invoke_agent_runtime(
                agentRuntimeArn=runtime_arn,
                runtimeSessionId=session_id,
                runtimeUserId=user_id,
                payload=payload,
                qualifier=self._qualifier,
                accountId=ACCOUNT_ID,
            )
            sub_agent_response = parse_agent_runtime_response(
                response.get("response"), agent_name=self._agent_runtime_id
            )
        except ClientError as err:
            sub_agent_response = (
                f"Error in the sub-agent responsible for "
                f"{self.get_tool_description()}: {str(err)}"
            )

        return sub_agent_response


__all__ = [
    "AVAILABLE_TOOLS",
    "AVAILABLE_MCPS",
    "RetrievalConfiguration",
]
