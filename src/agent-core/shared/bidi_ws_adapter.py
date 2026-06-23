# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# WebSocket adapters for the Strands BidiAgent protocol.
# Bridges FastAPI WebSocket <-> BidiAgent input/output protocols.
# ---------------------------------------------------------------------------- #
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from fastapi import WebSocket

if TYPE_CHECKING:
    from strands.experimental.bidi import BidiAgent

logger = logging.getLogger("agentcore.bidi_ws_adapter")


class WebSocketBidiInput:
    """Adapter that reads from a FastAPI WebSocket and produces BidiInputEvents.

    Implements the BidiInput protocol for Strands BidiAgent.
    """

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket

    async def start(self, agent: "BidiAgent") -> None:
        """Called when the BidiAgent starts processing inputs."""
        logger.info("WebSocket BidiInput started")

    async def stop(self) -> None:
        """Called when the BidiAgent stops processing inputs."""
        logger.info("WebSocket BidiInput stopped")

    async def __call__(self):
        """Read a JSON message from WebSocket and convert to a BidiInputEvent."""
        from strands.experimental.bidi import (
            BidiAudioInputEvent,
            BidiTextInputEvent,
        )

        data = await self._ws.receive_json()
        msg_type = data.get("type", "")

        if msg_type == "bidi_audio_input":
            return BidiAudioInputEvent(
                audio=data["audio"],
                format=data.get("format", "pcm"),
                sample_rate=data.get("sample_rate", 16000),
                channels=data.get("channels", 1),
            )
        elif msg_type == "bidi_text_input":
            return BidiTextInputEvent(
                text=data.get("text", ""),
                role=data.get("role", "user"),
            )
        elif msg_type == "voice_save":
            # Save voice conversation to DynamoDB before closing
            self._save_voice_session(data)
            # Continue reading — the next message will be bidi_close
            return await self.__call__()
        elif msg_type == "bidi_close":
            # BidiConnectionCloseEvent is an OUTPUT event, not a valid INPUT type.
            # Raise WebSocketDisconnect to trigger graceful shutdown via voice_agent.stop()
            from fastapi import WebSocketDisconnect

            raise WebSocketDisconnect(
                code=1000, reason=data.get("reason", "user_request")
            )
        else:
            # Unknown message type — treat as text input
            logger.warning(f"Unknown bidi input type: {msg_type}, treating as text")
            return BidiTextInputEvent(
                text=json.dumps(data),
                role="user",
            )

    def _save_voice_session(self, data: dict) -> None:
        """Save voice conversation turns to DynamoDB session history.

        Uses the same save_conversation_exchange() function as text mode.
        """
        from shared.session_history import save_conversation_exchange

        session_id = data.get("sessionId", "")
        turns = data.get("turns", [])
        runtime_id = data.get("agentRuntimeId", "")
        qualifier = data.get("qualifier", "DEFAULT")
        runtime_version = data.get("runtimeVersion")

        if not session_id or not turns:
            logger.warning("voice_save: missing sessionId or turns — skipping")
            return

        # Consolidate turns into user/assistant pairs for DynamoDB
        # Group consecutive same-role turns, tool turns go into assistant text
        user_text = ""
        assistant_text = ""
        pair_count = 0

        for turn in turns:
            role = turn.get("role", "")
            text = turn.get("text", "")

            if role == "user":
                # Flush any pending assistant text as a pair
                if assistant_text and user_text:
                    pair_count += 1
                    message_id = f"voice-{pair_count}"
                    try:
                        save_conversation_exchange(
                            session_id=session_id,
                            user_id="",  # Voice mode doesn't track userId
                            message_id=message_id,
                            user_message=user_text.strip(),
                            ai_response=assistant_text.strip(),
                            runtime_id=runtime_id,
                            runtime_version=runtime_version,
                            endpoint_name=qualifier,
                        )
                    except Exception as e:
                        logger.warning(f"Failed to save voice exchange: {e}")
                    user_text = ""
                    assistant_text = ""
                user_text += (" " if user_text else "") + text

            elif role == "assistant":
                # Flush any pending user text if we're starting a new assistant block
                if user_text and not assistant_text:
                    pass  # keep accumulating — will flush when user speaks again
                assistant_text += (" " if assistant_text else "") + text

            elif role == "tool":
                # Add tool info as context in assistant text
                assistant_text += (" " if assistant_text else "") + f"[Tool: {text}]"

        # Flush final pair
        if user_text or assistant_text:
            pair_count += 1
            message_id = f"voice-{pair_count}"
            try:
                save_conversation_exchange(
                    session_id=session_id,
                    user_id="",
                    message_id=message_id,
                    user_message=user_text.strip() if user_text else "(voice session)",
                    ai_response=assistant_text.strip() if assistant_text else "",
                    runtime_id=runtime_id,
                    runtime_version=runtime_version,
                    endpoint_name=qualifier,
                )
            except Exception as e:
                logger.warning(f"Failed to save final voice exchange: {e}")

        logger.info(
            f"Voice session saved: {pair_count} exchanges for session {session_id}"
        )


class WebSocketBidiOutput:
    """Adapter that receives BidiOutputEvents and sends them over a FastAPI WebSocket.

    Implements the BidiOutput protocol for Strands BidiAgent.
    On each tool use it sends a raw `tool_description` event over the WebSocket
    (no LLM rephrasing) — the UI renders a `Using {toolName}` fallback.
    """

    def __init__(self, websocket: WebSocket, session_id: str = "") -> None:
        self._ws = websocket
        self._session_id = session_id
        self._tool_invocation_count = 0

    async def start(self, agent: "BidiAgent") -> None:
        """Called when the BidiAgent starts producing outputs."""
        logger.info("WebSocket BidiOutput started")

    async def stop(self) -> None:
        """Called when the BidiAgent stops producing outputs."""
        logger.info("WebSocket BidiOutput stopped")

    async def __call__(self, event: Any) -> None:
        """Convert a BidiOutputEvent to JSON and send over WebSocket."""
        import re

        try:
            event_class = type(event).__name__

            # Convert CamelCase class name to snake_case for the type field
            # e.g., BidiAudioStreamEvent -> bidi_audio_stream
            snake_name = re.sub(r"(?<!^)(?=[A-Z])", "_", event_class).lower()
            # Remove trailing "_event"
            if snake_name.endswith("_event"):
                snake_name = snake_name[: -len("_event")]

            # Build the event data with all available attributes.
            # TypedEvent is a dict subclass — data is in dict keys, not object attrs.
            # We check both getattr (for @property) and dict .get() access.
            event_data: dict = {"type": snake_name}
            for attr in (
                "text",
                "audio",
                "role",
                "is_final",
                "reason",
                "format",
                "sample_rate",
                "connection_id",
                "stop_reason",
                "response_id",
            ):
                # Try property access first, then dict access
                val = getattr(event, attr, None)
                if val is None and isinstance(event, dict):
                    val = event.get(attr)
                if val is not None:
                    event_data[attr] = val

            # Special handling for tool events: extract tool name and input
            # from the "current_tool_use" dict (used by ToolUseStreamEvent)
            if isinstance(event, dict) and "current_tool_use" in event:
                tool_use = event["current_tool_use"]
                if isinstance(tool_use, dict):
                    tool_name = tool_use.get("name", "")
                    tool_input = tool_use.get("input", {})

                    if tool_name:
                        event_data["tool_name"] = tool_name
                    if tool_input:
                        if isinstance(tool_input, dict):
                            event_data["content"] = json.dumps(tool_input)
                        else:
                            event_data["content"] = str(tool_input)
                    if "toolUseId" in tool_use:
                        event_data["tool_use_id"] = tool_use["toolUseId"]

                    # Send the raw tool info over the WebSocket as a tool_description
                    # event. No LLM rephrasing (consistent with the text path) — the
                    # UI applies a `Using {toolName}` fallback when description is empty.
                    # Sending inline is safe: no blocking Bedrock call remains, so it
                    # won't stall the audio event loop.
                    if tool_name and self._session_id:
                        self._tool_invocation_count += 1
                        await self._ws.send_json(
                            {
                                "type": "tool_description",
                                "tool_name": tool_name,
                                "description": "",
                                "invocation_number": self._tool_invocation_count,
                            }
                        )

            # Skip noisy lifecycle/usage events that the frontend doesn't need
            # Note: bidi_response_complete is NOT skipped — frontend uses it to
            # reveal the agent's text when the response is done
            skip_types = {
                "bidi_connection_start",
                "bidi_connection_close",
                "bidi_usage",
                "bidi_response_start",
            }
            if snake_name in skip_types:
                logger.debug(f"Skipping bidi event: {snake_name}")
                return

            await self._ws.send_json(event_data)
        except Exception as e:
            logger.warning(f"Failed to send bidi output event: {e}")
