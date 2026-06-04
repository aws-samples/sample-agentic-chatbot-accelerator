# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Direct A2A JSON-RPC client used by graph node functions.

Graph nodes need a *direct* per-node call (not the tool-shaped surface that
``A2AClientToolProvider`` exposes for LLM-driven orchestrators) because:

1. Each node passes shared graph state alongside the prompt as a structured
   ``DataPart`` — no LLM tool call decides whether to forward state.
2. Each node expects to recover the sub-agent's structured output to merge
   back into graph state. The agents-as-tools text-tool surface drops it.

The wire shape mirrors ``cache/scripts/eval-a2a.py`` so behaviour stays in
lock-step with the standalone evaluator: SigV4-signed httpx, JSON-RPC
``message/send`` with the AgentCore runtime-session header.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

import boto3
import httpx
from shared.agentcore_a2a import runtime_arn_to_a2a_url
from shared.sigv4_auth import SigV4HTTPXAuth

logger = logging.getLogger(__name__)

# 5 minutes — matches the default timeout the orchestrator's
# A2AClientToolProvider uses, so a slow sub-agent fails the same way under
# both call paths.
DEFAULT_TIMEOUT_SECONDS = 300.0


class A2AInvocationResult:
    """Plain container for the parts of a sub-agent A2A response a graph cares about.

    Attributes:
        content:           Concatenated text from every TextPart in the response.
        structured_output: First DataPart's payload, if any. Sub-agents emit
                           at most one (see :class:`StructuredOutputA2AExecutor`).
    """

    __slots__ = ("content", "structured_output")

    def __init__(self, content: str, structured_output: dict | None = None):
        self.content = content
        self.structured_output = structured_output


def invoke_a2a_subagent(
    *,
    runtime_arn: str,
    region: str,
    prompt: str,
    session_id: str,
    user_id: str,
    state: dict | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> A2AInvocationResult:
    """Send a JSON-RPC ``message/send`` to an A2A sub-agent runtime.

    *state* — when provided — is encoded as a ``DataPart`` next to the
    ``TextPart`` carrying *prompt*. Strands' executor converts ``DataPart`` to
    a ``[Structured Data]\\n<json>`` content block on the sub-agent side, so
    the sub-agent's prompt sees the state inline. The graph factory therefore
    doesn't need a separate "state" channel — A2A parts carry it.

    The response is parsed into an :class:`A2AInvocationResult`. Both
    streaming task histories and the final ``artifacts`` field are scanned
    so this works regardless of whether the sub-agent is using A2A-compliant
    or legacy streaming.
    """
    url = runtime_arn_to_a2a_url(runtime_arn, region)

    parts: list[dict[str, Any]] = [{"kind": "text", "text": prompt}]
    if state:
        parts.append({"kind": "data", "data": state})

    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": parts,
                "messageId": str(uuid.uuid4()),
                "metadata": {"userId": user_id},
            }
        },
    }

    auth = SigV4HTTPXAuth(
        credentials=boto3.Session().get_credentials(),
        service="bedrock-agentcore",
        region=region,
    )

    # AgentCore uses this header to pin the call to a microVM. We mint a
    # fresh session-id per node call (see graph factory) so each node lives
    # in its own microVM — no leakage between graph nodes that happen to
    # share a sub-agent runtime.
    headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id}

    with httpx.Client(auth=auth, timeout=timeout_seconds) as client:
        response = client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        rpc = response.json()

    if "error" in rpc:
        raise RuntimeError(f"A2A sub-agent error from {runtime_arn}: {rpc['error']}")

    return _extract_result(rpc.get("result") or {})


def _extract_result(result: dict[str, Any]) -> A2AInvocationResult:
    """Pull text + structured output from a JSON-RPC ``message/send`` result.

    Output lives in two places depending on streaming mode:
      * single-shot ``message/send``:  ``result.message.parts``
      * streamed task:                  ``result.artifacts[*].parts``

    We deliberately do **not** walk ``result.history`` — A2A's task history
    includes the *input* message we sent (carrying our state ``DataPart``),
    and absorbing it would clobber the output ``structured_output`` with our
    own input and bleed our input ``TextPart`` into the response text. Bug
    seen in graph map-reduce: input ``{_session_id, _user_id, partial_templates: []}``
    flowing back as the sub-agent's structured output.
    """
    text_chunks: list[str] = []
    structured_output: dict | None = None
    saw_any_part = False

    def _absorb_parts(parts: list[dict[str, Any]] | None) -> None:
        nonlocal structured_output, saw_any_part
        if not parts:
            return
        for part in parts:
            saw_any_part = True
            kind = part.get("kind") or part.get("type")
            if kind == "text":
                text = part.get("text") or ""
                if text:
                    text_chunks.append(text)
            elif kind == "data":
                data = part.get("data")
                if isinstance(data, dict):
                    structured_output = data

    # Single-shot response shape: result.message.parts
    msg = result.get("message")
    if isinstance(msg, dict):
        _absorb_parts(msg.get("parts"))

    # Streaming task shape: result.artifacts[*].parts
    for artifact in result.get("artifacts") or []:
        _absorb_parts(artifact.get("parts"))

    if not saw_any_part:
        # The bespoke /invocations path raised on empty responses so callers
        # would see cold-start / malformed-response failures instead of a
        # blank successful turn. Preserve that behaviour for A2A.
        raise RuntimeError(
            "Empty A2A sub-agent response — no text or data parts in "
            "result.message or result.artifacts; the agent may still be "
            "initializing or the invocation timed out"
        )

    return A2AInvocationResult(
        content="".join(text_chunks),
        structured_output=structured_output,
    )
