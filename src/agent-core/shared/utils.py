# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared utilities for agent implementations.
# ---------------------------------------------------------------------------- #
import os
import re
from typing import Optional

from pydantic import BaseModel, ValidationError


def get_uvicorn_host() -> str:
    """Return the bind address for the uvicorn server.

    AgentCore-hosted containers must listen on all interfaces so the platform
    can route traffic to them; everywhere else (local dev) we bind loopback.
    Centralized so all four agent-pattern entrypoints share one decision and
    one bandit suppression.
    """
    return "0.0.0.0" if os.getenv("DOCKER_CONTAINER") else "127.0.0.1"  # nosec B104


def deserialize(value: str, object_type: type[BaseModel]) -> BaseModel:
    """Deserialize a JSON string to a Pydantic model.

    Args:
        value: JSON string to deserialize
        object_type: Target Pydantic model type

    Returns:
        Parsed Pydantic model instance

    Raises:
        ValidationError: If the JSON doesn't match the model schema
    """
    try:
        parsed_object = object_type.model_validate_json(value)
    except ValidationError as err:
        print(f"Validation error: {err}")
        raise err

    return parsed_object


def extract_tag_content(llm_response: str, tag: str) -> Optional[str]:
    """Extracts content between XML-style tags from a string.

    Args:
        llm_response (str): The string containing the tagged content
        tag (str): The name of the tag to extract content from

    Returns:
        Optional[str]: The content between the tags if found, None otherwise.
            If opening/closing tags are missing, they will be added automatically.

    Examples:
        >>> extract_tag_content("<foo>bar</foo>", "foo")
        'bar'
    """
    if f"<{tag}>" not in llm_response:
        llm_response = f"<{tag}>" + llm_response
    if f"</{tag}>" not in llm_response:
        llm_response = llm_response + f"</{tag}>"
    pattern = f"<{tag}>(.*?)</{tag}>"
    matches = re.findall(pattern, llm_response, re.DOTALL)

    # filter out empty matches
    matches = [elem for elem in matches if elem]

    return matches[-1] if matches else None


def enrich_trajectory(trajectory_session, tool_executions: dict, log) -> dict:
    """Enrich trajectory with captured tool arguments and results.

    The Strands OpenTelemetry instrumentation doesn't capture MCP tool arguments
    properly. This function post-processes the trajectory to inject the tool
    data that was captured by the callbacks.

    Args:
        trajectory_session: Session object from StrandsInMemorySessionMapper
        tool_executions: Dict of tool execution data keyed by tool_call_id
        log: Logger instance

    Returns:
        Enriched trajectory (either Session object or dict depending on input)
    """
    if not tool_executions:
        return trajectory_session

    try:
        # Handle both Session object and dict representation
        if hasattr(trajectory_session, "model_dump"):
            # Convert to dict for easier manipulation
            trajectory_dict = trajectory_session.model_dump()
        elif hasattr(trajectory_session, "dict"):
            trajectory_dict = trajectory_session.dict()
        elif isinstance(trajectory_session, dict):
            trajectory_dict = trajectory_session
        else:
            log.warning(f"Unknown trajectory type: {type(trajectory_session)}")
            return trajectory_session

        enriched_count = 0

        # Iterate through traces and spans to find tool execution spans
        for trace in trajectory_dict.get("traces", []):
            for span in trace.get("spans", []):
                # Check if this is a tool execution span
                tool_call = span.get("tool_call")
                if tool_call:
                    tool_call_id = tool_call.get("tool_call_id", "")

                    # Look up the captured tool data
                    if tool_call_id in tool_executions:
                        captured_data = tool_executions[tool_call_id]

                        # Inject arguments if they were captured
                        if "arguments" in captured_data:
                            tool_call["arguments"] = captured_data["arguments"]
                            enriched_count = 1

                        # Inject result if it was captured
                        tool_result = span.get("tool_result")
                        if tool_result and "result" in captured_data:
                            tool_result["content"] = captured_data["result"]

        if enriched_count > 0:
            log.info(
                f"Enriched {enriched_count} tool calls in trajectory with captured arguments",
                extra={"enrichedCount": enriched_count},
            )

        return trajectory_dict

    except Exception as e:
        log.warning(f"Failed to enrich trajectory: {e}", extra={"error": str(e)})
        return trajectory_session
