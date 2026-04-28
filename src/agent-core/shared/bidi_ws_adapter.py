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
            BidiConnectionCloseEvent,
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
        elif msg_type == "bidi_close":
            return BidiConnectionCloseEvent(
                connection_id=data.get("connection_id", "ws"),
                reason=data.get("reason", "user_request"),
            )
        else:
            # Unknown message type — treat as text input
            logger.warning(f"Unknown bidi input type: {msg_type}, treating as text")
            return BidiTextInputEvent(
                text=json.dumps(data),
                role="user",
            )


class WebSocketBidiOutput:
    """Adapter that receives BidiOutputEvents and sends them over a FastAPI WebSocket.

    Implements the BidiOutput protocol for Strands BidiAgent.
    """

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket

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

            # Build the event data with all available attributes
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
            ):
                if hasattr(event, attr):
                    event_data[attr] = getattr(event, attr)

            # Skip noisy lifecycle/usage events that the frontend doesn't need
            skip_types = {
                "bidi_connection_start",
                "bidi_connection_close",
                "bidi_usage",
                "bidi_response_start",
                "bidi_response_complete",
            }
            if snake_name in skip_types:
                logger.debug(f"Skipping bidi event: {snake_name}")
                return

            await self._ws.send_json(event_data)
        except Exception as e:
            logger.warning(f"Failed to send bidi output event: {e}")
