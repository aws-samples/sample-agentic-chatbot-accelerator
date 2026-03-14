# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from dataclasses import dataclass
from typing import Sequence


class AcaException(Exception):
    """Base definition of exception that functions part of `genai_core` can raise

    Attributes:
        __error_code__ (int): error code associated with the exception
    """

    __error_code__ = 0
    __app__ = "ACA"

    @classmethod
    def get_error_number(cls) -> int:
        """Get the numeric error code associated with this exception.

        Returns:
            int: The error code number defined in the __error_code__ class attribute
        """
        return cls.__error_code__

    @classmethod
    def get_error_code(cls) -> str:
        """Get the string representation of the error code"""
        return f"{cls.__app__}-{str(cls.__error_code__).zfill(3)}"

    def __str__(self) -> str:
        """Format error message."""
        return f"Custom exception: {super().__str__()}"


class UserNotFoundException(AcaException):
    """Exception raised when a user is not found in the system.

    Error code: 001
    """

    __error_code__ = 1

    def __str__(self):
        return f"[{self.get_error_code()}] User not found"


@dataclass
class WriteToDynamoError(AcaException):
    """Exception raised when a write to DynamoDB operation fails

    Error code: 002

    Attributes:
        table_name (str): Name of the DynamoDB table that failed to write

    """

    __error_code__ = 2

    table_name: str

    def __str__(self):
        return f"[{self.get_error_code()}] Unable to write to table {self.table_name}"


@dataclass
class ReadFromDynamoError(AcaException):
    """Exception raised when a read from DynamoDB operation fails

    Error code: 003

    Attributes:
        table_name (str): Name of the DynamoDB table that failed to read from

    """

    __error_code__ = 3

    table_name: str

    def __str__(self):
        return f"[{self.get_error_code()}] Unable to read from table {self.table_name}"


class StartTranscribeJobError(AcaException):
    """Exception raised when starting an Amazon Transcribe job fails

    Error code: 004
    """

    __error_code__ = 4

    def __str__(self):
        return f"[{self.get_error_code()}] Unable to start Amazon Transcribe job"


class TranscribeJobFailed(AcaException):
    """Exception raised when an Amazon Transcribe job fails to complete

    Error code: 005
    """

    __error_code__ = 5

    def __str__(self):
        return f"[{self.get_error_code()}] Unable to complete Amazon Transcribe job"


@dataclass
class BadClient(AcaException):
    """Exception raised when an AWS client is missing required methods

    Error code: 006

    Attributes:
        methods (Sequence[str]): List of method names that are missing from the client
    """

    __error_code__ = 6

    methods: Sequence[str]

    def __str__(self):
        return f"[{self.get_error_code()}] The AWS client is missing the following methods: {','.join(self.methods)}"


@dataclass
class InvalidReference(AcaException):
    """Exception raised when a reference is not valid

    Error code: 007

    Attributes:
        reference_type (str): Type of the invalid reference
        reference_id (str): Identifier of the invalid reference
    """

    __error_code__ = 7

    reference_type: str
    reference_id: str

    def __str__(self):
        return f"[{self.get_error_code()}] Reference of type {self.reference_type} with identifier {self.reference_id} is not valid"


@dataclass
class BedrockRuntimeValidationException(AcaException):
    """Exception raised when a model cannot be used for on-demand throughput

    Error code: 008

    Attributes:
        original_err_message (str): original error message returned by botocore
    """

    __error_code__ = 8

    original_err_message: str

    def __str__(self):
        return f"[{self.get_error_code()}] {self.original_err_message}"


@dataclass
class BedrockRuntimeThrottlingException(AcaException):
    """Exception raised when a model cannot be used for on-demand throughput

    Error code: 008

    Attributes:
        original_err_message (str): original error message returned by botocore
    """

    __error_code__ = 9

    model_arn: str
    original_err_message: str

    def __str__(self):
        return f"[{self.get_error_code()}] Model [{self.model_arn.split('/')[-1]}]: {self.original_err_message}"


@dataclass
class InvalidConfiguration(AcaException):
    __error_code__ = 10

    def __str__(self):
        return f"[{self.get_error_code()}] There's an issue with your profile's inference settings. To resolve this:\n\n- Review the current configuration\n- Check for any invalid or missing parameters\n- Use another configuration."


@dataclass
class KnowledgeBaseWithNoIndexedDocuments(AcaException):
    """Exception raised when a knowledge base has no indexed documents

    Error code: 011

    Attributes:
        bedrock_session_id (str): Identifier of the knowledge base that has no indexed documents
    """

    __error_code__ = 11

    bedrock_session_id: str

    def __str__(self):
        return f"[{self.get_error_code()}] No indexed documents found in knowledge base '{self.bedrock_session_id}'. Please sync your data sources to populate the knowledge base."


@dataclass
class FailedIndexCreation(AcaException):
    __error_code__ = 12

    def __str__(self):
        return (
            f"[{self.get_error_code()}] Failed to create opensearch serverless index."
        )


@dataclass
class FailedIndexDeletion(AcaException):
    __error_code__ = 123

    def __str__(self):
        return (
            f"[{self.get_error_code()}] Failed to delete opensearch serverless index."
        )


@dataclass
class StrandsAgentsError(AcaException):
    __error_code__ = 14

    err_msg: str

    def __str__(self):
        return f"[{self.get_error_code()}] Strands agents runtime error: {self.err_msg}"
