# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# Shared module for common code between agentic framework implementations
# ---------------------------------------------------------------------------- #
from .agentcore_memory import create_session_manager
from .base_callbacks import FormatCitations
from .base_constants import (
    INVOKE_SUBAGENT_PREFIX,
    RETRIEVE_FROM_KB_PREFIX,
    TOOL_DESCRIPTIONS,
)
from .kb_types import (
    BedrockRerankingConfiguration,
    Citation,
    EContentType,
    ELocationType,
    ERerankingMetadataSelectionMode,
    ERowType,
    ESearchType,
    ImplicitFilterConfiguration,
    Interval,
    KnowledgeBaseRetrievalConfiguration,
    MetadataAttribute,
    ReferenceContent,
    ReferenceLocation,
    RerankingConfiguration,
    RerankingFieldName,
    RerankingMetadataConfiguration,
    RerankingModelConfiguration,
    RerankingSelectiveModeConfiguration,
    RetrievalConfiguration,
    RetrievedReference,
    TextResponsePart,
    TextResponsePartElement,
)
from .mcp_auth import (
    SigV4HTTPXAuth,
    StreamableHTTPTransportWithSigV4,
    streamablehttp_client_with_sigv4,
)
from .mcp_client import MCPClientManager
from .stream_types import (
    ChatbotAction,
    EConversationManagerType,
    EStreamEvent,
    InferenceConfig,
    ModelConfiguration,
    StrandToken,
    Token,
)
from .utils import deserialize, enrich_trajectory, extract_tag_content

__all__ = [
    # AgentCore Memory
    "create_session_manager",
    # Base callbacks
    "FormatCitations",
    # Base constants
    "INVOKE_SUBAGENT_PREFIX",
    "RETRIEVE_FROM_KB_PREFIX",
    "TOOL_DESCRIPTIONS",
    # Bedrock Knowledge Base Types
    "BedrockRerankingConfiguration",
    "Citation",
    "EContentType",
    "ELocationType",
    "ERerankingMetadataSelectionMode",
    "ERowType",
    "ESearchType",
    "ImplicitFilterConfiguration",
    "Interval",
    "KnowledgeBaseRetrievalConfiguration",
    "MetadataAttribute",
    "ReferenceContent",
    "ReferenceLocation",
    "RerankingConfiguration",
    "RerankingFieldName",
    "RerankingMetadataConfiguration",
    "RerankingModelConfiguration",
    "RerankingSelectiveModeConfiguration",
    "RetrievalConfiguration",
    "RetrievedReference",
    "TextResponsePart",
    "TextResponsePartElement",
    # MCP authentication
    "SigV4HTTPXAuth",
    "StreamableHTTPTransportWithSigV4",
    "streamablehttp_client_with_sigv4",
    # MCP client
    "MCPClientManager",
    # Chatbot related types
    "ChatbotAction",
    "EConversationManagerType",
    "EStreamEvent",
    "InferenceConfig",
    "ModelConfiguration",
    "StrandToken",
    "Token",
    # utils
    "deserialize",
    "extract_tag_content",
    "enrich_trajectory",
]
