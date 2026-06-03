# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from urllib.parse import quote

# Server protocol exposed by the container, selected per-runtime by AgentCore.
# Sub-agent images deploy as twin runtimes — one HTTP (UI / /ws), one A2A
# (orchestrator -> sub-agent).
SERVER_PROTOCOL_HTTP = "HTTP"
SERVER_PROTOCOL_A2A = "A2A"

# AgentCore A2A protocol mode mounts the A2A server at "/" on port 9000.
# HTTP protocol mode uses port 8080. Same image, different listen behavior
# selected at start-up via the `agentcoreServerProtocol` env var.
A2A_PORT = 9000
HTTP_PORT = 8080


def runtime_arn_to_a2a_url(runtime_arn: str, region: str) -> str:
    """Compute the AgentCore A2A invocation URL for a runtime ARN.

    AgentCore exposes A2A-mode runtimes at::

        https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urlencode(arn)}/invocations/

    The trailing slash matters — A2A servers mount at "/", and the Strands
    A2A client expects this exact path so it can resolve the agent card at
    "/.well-known/agent-card.json" and post JSON-RPC to "/".
    """
    encoded_arn = quote(runtime_arn, safe="")
    return f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{encoded_arn}/invocations/"
