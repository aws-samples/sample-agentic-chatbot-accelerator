# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ----------------------------------------------------------------------
from enum import Enum
from typing import Optional, Sequence

from pydantic import BaseModel, Field, computed_field, model_validator


class ChatbotAction(Enum):
    """
    Enum class defining the possible actions that can be taken by the chatbot.

    Attributes:
        HEARTBEAT: Represents a heartbeat action to check if the chatbot is active
        RUN: Represents the main execution action of the chatbot
        ON_NEW_LLM_TOKEN: Represents a new token received from the language model that belongs to the final answer
        FINAL_RESPONSE: Represents the final response action from the chatbot
    """

    HEARTBEAT = "heartbeat"
    RUN = "run"
    ON_NEW_LLM_TOKEN = (
        "on_new_llm_token"  # nosec B105 - not a password, chatbot action type
    )
    FINAL_RESPONSE = "final_response"


class StatusResponse(Enum):
    SUCCESSFUL = "SUCCESSFUL"
    INVALID_CONFIG = "INVALID_CONFIG"
    INVALID_NAME = "INVALID_NAME"
    UNKNOWN_ERROR = "UNKNOWN_ERROR"
    SERVICE_ERROR = "SERVICE_ERROR"
    ALREADY_EXISTS = "ALREADY_EXISTS"


class KnowledgeBase(BaseModel):
    """Python representation of `KnowledgeBase` defined in GraphQL schema

    Attributes:
        name (str): The name of the knowledge base
        id (str): The unique identifier for the knowledge base
        arn (str): The Amazon Resource Name (ARN) for the knowledge base
        owner (str): The Knowledge base owner. All those created with CDK are owned by "Admin"
        description (Optional[str]): Optional description of the knowledge base
    """

    name: str
    id: str
    arn: str
    owner: str
    description: Optional[str]


class S3DataSource(BaseModel):
    """Python representation of `S3DataSource` defined in GraphQL schema

    Attributes:
        name (str): The name of the S3 data source
        prefix (str): The S3 prefix/path where the data source files are located
        description (Optional[str]): Optional description of the S3 data source
    """

    name: str
    id: str
    prefixes: Sequence[str]
    description: Optional[str]


class S3Document(BaseModel):
    DocumentId: str
    BucketName: str
    DocumentType: str
    ObjectName: str
    RawInputPrefix: str

    def as_query_response(self):
        return {
            "id": self.DocumentId,
            "name": ".".join(self.ObjectName.split(".")[:-1]),
            "uri": self._get_uri(),
            "documentType": self.DocumentType,
            "inputPrefix": self.RawInputPrefix,
        }

    def _get_uri(self):
        return f"s3://{self.BucketName}/{self.RawInputPrefix}/{self.ObjectName}"


class Precision(Enum):
    BINARY = "BINARY"
    FLOAT = "FLOAT"


class EmbeddingModel(BaseModel):
    id: str
    vectorSize: int
    precision: Precision

    @computed_field
    def precision_for_kb(self) -> str:
        return "BINARY" if self.precision == Precision.BINARY else "FLOAT32"

    @computed_field
    def distance(self) -> str:
        return "hamming" if self.precision == Precision.BINARY else "l2"


class FixedChunkingProps(BaseModel):
    maxTokens: int
    overlapPercentage: int


class HierarchicalChunkingProps(BaseModel):
    overlapTokens: int
    maxParentTokenSize: int
    maxChildTokenSize: int


class SemanticChunkingProps(BaseModel):
    bufferSize: int = Field(ge=0, le=1)
    breakpointPercentileThreshold: int
    maxTokens: int


class ChunkingType(Enum):
    FIXED = "FIXED_SIZE"
    HIERARCHICAL = "HIERARCHICAL"
    SEMANTIC = "SEMANTIC"
    NONE = "NONE"


class Chunking(BaseModel):
    type: ChunkingType
    fixedChunkingProps: Optional[FixedChunkingProps] = None
    hierarchicalChunkingProps: Optional[HierarchicalChunkingProps] = None
    semanticChunkingProps: Optional[SemanticChunkingProps] = None


class DataSource(BaseModel):
    id: str
    inputPrefix: str
    dataSourcePrefix: str
    chunkingProps: Chunking
    description: Optional[str] = None


class KnowledgeBaseProps(BaseModel):
    name: str
    model: EmbeddingModel
    dataSources: Sequence[DataSource]
    description: Optional[str] = None


class ExecutionMode(Enum):
    BEDROCK_KB = "BEDROCK_KB"
    STRANDS_AGENT = "STRANDS_AGENT"


## ---------- ##
# TODO - copy paste below - 2 be refactored
class EConversationManagerType(str, Enum):
    """Defines the possible conversation manager types for handling chat history.

    Attributes:
        NULL: No conversation management - each message is handled independently
        SLIDING_WINDOW: Maintains a sliding window of recent messages for context
        SUMMARIZING: Summarizes older messages to maintain context while managing memory
    """

    NULL = "null"
    SLIDING_WINDOW = "sliding_window"
    SUMMARIZING = "summarizing"


class InferenceConfig(BaseModel):
    """Configuration for model inference parameters.

    Attributes:
        maxTokens (int): Maximum number of tokens to generate in the response
        temperature (float): Controls randomness in response generation. Higher values (e.g. 1.0) make output more random,
            lower values (e.g. 0.1) make it more focused and deterministic
        stopSequences (Optional[List[str]]): List of sequences that will stop text generation when encountered. Default None
    """

    maxTokens: int
    temperature: float
    stopSequences: Optional[list[str]] = None


class ModelConfiguration(BaseModel):
    """Configuration class for model inference settings.

    Attributes:
        modelId (str): Identifier for the model to be used
        parameters (InferenceConfig): Configuration parameters for model inference
    """

    modelId: str
    parameters: InferenceConfig


class AgentConfiguration(BaseModel):
    modelInferenceParameters: ModelConfiguration
    instructions: str
    tools: list[str]
    toolParameters: dict[str, dict]
    mcpServers: list[str]
    conversationManager: EConversationManagerType = (
        EConversationManagerType.SLIDING_WINDOW
    )
    useMemory: bool = False

    @model_validator(mode="after")
    def validate_tool_parameters(self):
        """Validates that tool parameters match the defined tools.

        Checks that:
        - All tool parameter keys correspond to defined tools
        - Sub-agent tools have required agentName and agentVersion parameters

        Returns:
            AgentConfiguration: The validated configuration object

        Raises:
            ValueError: If validation fails due to missing or invalid parameters
        """
        tool_names = {tool_name for tool_name in self.tools}
        invalid_keys = set(self.toolParameters.keys()) - tool_names
        if invalid_keys:
            raise ValueError(f"toolParameters keys {invalid_keys} not found in tools")

        return self
