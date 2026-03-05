# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared utilities for agent implementations.
# ---------------------------------------------------------------------------- #
import codecs
import json
import re
from typing import Any, Optional, Tuple

from pydantic import BaseModel, ValidationError


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


# ---------------------------------------------------------------------------- #
# Agent Runtime SSE response parsing
# ---------------------------------------------------------------------------- #


def parse_sse_events(stream: str) -> Tuple[list[dict], str]:
    """Parse SSE events from a stream buffer and extract JSON events.

    Uses regex to find ``data: {...}`` patterns in the buffer, returning
    successfully parsed events and any remaining unparsed data that may
    contain an incomplete event to be completed by the next chunk.

    Args:
        stream: Raw stream data (potentially containing multiple SSE events).

    Returns:
        A tuple of (parsed_events, remaining_unparsed_data).
    """
    parsed_events: list[dict] = []
    unparsed_data = stream

    while True:
        event_match = re.search(r"data: ({.*?})\n", unparsed_data)
        if not event_match:
            break
        try:
            parsed_events.append(json.loads(event_match.group(1)))
            unparsed_data = (
                unparsed_data[: event_match.start()]
                + unparsed_data[event_match.end() :]
            )
        except json.JSONDecodeError:
            break

    return parsed_events, unparsed_data


def parse_agent_runtime_response(
    response_stream: Any,
    agent_name: str = "agent",
) -> str:
    """Read and parse a streaming SSE response from ``invoke_agent_runtime``.

    Handles the full lifecycle of reading the response stream:
    1. Incremental UTF-8 decoding to handle multi-byte characters split
       across chunk boundaries.
    2. SSE event extraction via :func:`parse_sse_events`.
    3. Extraction of the final answer from the ``final_response`` event,
       with fallback to concatenated ``on_new_llm_token`` tokens.

    Args:
        response_stream: The ``response["response"]`` object returned by
            ``invoke_agent_runtime``. Can be an iterable of chunks or a
            file-like object with a ``read()`` method.
        agent_name: Human-readable agent name used in error messages.

    Returns:
        The final text content produced by the agent.

    Raises:
        RuntimeError: If the agent returns an error event, the stream is
            empty, or the stream cannot be read.
    """
    utf8_decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
    buffer = ""
    final_content: str | None = None
    token_values: list[str] = []
    received_any_chunk = False

    def _process_events(events: list[dict]) -> None:
        """Process parsed SSE events, extracting final content or tokens."""
        nonlocal final_content
        for event in events:
            action = event.get("action", "")
            data = event.get("data", {})

            if event.get("error"):
                raise RuntimeError(
                    f"Sub-agent '{agent_name}' returned error: {event['error']}"
                )

            if action == "final_response":
                final_content = data.get("content", "")
            elif action == "on_new_llm_token":
                token = data.get("token", {})
                if isinstance(token, dict) and "value" in token:
                    token_values.append(token["value"])

    try:
        if hasattr(response_stream, "__iter__"):
            for chunk in response_stream:
                received_any_chunk = True
                raw_bytes: bytes | None = None

                if isinstance(chunk, dict):
                    if "chunk" in chunk:
                        chunk_data = chunk["chunk"]
                        if isinstance(chunk_data, dict) and "bytes" in chunk_data:
                            raw_bytes = chunk_data["bytes"]
                        elif isinstance(chunk_data, bytes):
                            raw_bytes = chunk_data
                    elif "bytes" in chunk:
                        raw_bytes = chunk["bytes"]
                    elif "payload" in chunk:
                        payload_data = chunk["payload"]
                        raw_bytes = (
                            payload_data
                            if isinstance(payload_data, bytes)
                            else str(payload_data).encode()
                        )
                    else:
                        for val in chunk.values():
                            if isinstance(val, bytes):
                                raw_bytes = val
                                break
                            elif isinstance(val, str):
                                raw_bytes = val.encode()
                                break
                elif isinstance(chunk, bytes):
                    raw_bytes = chunk
                else:
                    raw_bytes = str(chunk).encode()

                if raw_bytes is None:
                    continue

                decoded_text = utf8_decoder.decode(raw_bytes, final=False)
                events, buffer = parse_sse_events(buffer + decoded_text)
                _process_events(events)

                if final_content is not None:
                    break

        elif hasattr(response_stream, "read"):
            raw = response_stream.read()
            if raw:
                received_any_chunk = True
                raw_bytes = raw if isinstance(raw, bytes) else str(raw).encode()
                decoded_text = utf8_decoder.decode(raw_bytes, final=False)
                events, buffer = parse_sse_events(buffer + decoded_text)
                _process_events(events)

    except RuntimeError:
        raise
    except Exception as stream_err:
        raise RuntimeError(
            f"Failed to read response stream from agent '{agent_name}': {stream_err}"
        ) from stream_err

    # Flush any remaining bytes from the decoder
    final_text = utf8_decoder.decode(b"", final=True)
    if final_text:
        events, buffer = parse_sse_events(buffer + final_text)
        _process_events(events)

    if not received_any_chunk:
        raise RuntimeError(
            f"Empty response from agent '{agent_name}' — the agent may still "
            f"be initializing or the invocation timed out"
        )

    if final_content is not None:
        return final_content

    if token_values:
        return "".join(token_values)

    # Last resort: try parsing any remaining buffer as plain JSON (non-SSE response)
    remaining = buffer.strip()
    if remaining:
        try:
            parsed = json.loads(remaining)
            if isinstance(parsed, dict):
                if "error" in parsed:
                    raise RuntimeError(
                        f"Sub-agent '{agent_name}' returned error: {parsed['error']}"
                    )
                data = parsed.get("data", parsed)
                return str(data.get("content", data))
            return str(parsed)
        except json.JSONDecodeError:
            return remaining

    return ""
