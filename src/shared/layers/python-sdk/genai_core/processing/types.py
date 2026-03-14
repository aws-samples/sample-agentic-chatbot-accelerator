# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #
from enum import Enum

# ------------------------- Constants ------------------------ #
VIDEO_EXTENSIONS = (
    ".mp3",
    ".mp4",
    ".wav",
    ".flac",
    ".ogg",
    ".amr",
    ".webm",
)
BEDROCK_KB_SUPPORTED_OFFICE_EXTENSIONS = (
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
)
# PRESENTATION_EXTENSIONS = (
#     ".ppt",
#     ".pptx",
#     ".pps",
#     ".ppsx",
#     ".odp",
# )
# ------------------------------------------------------------- #


class TextExtractionState(Enum):
    """
    Enum class representing the various states of a transcription processing job.

    Attributes:
        SUBMITTED: Initial state when job is submitted
        IN_PROGRESS: Job is currently in progress
        FAILED: Job failed to complete
        SUCCEEDED: Job completed successfully
        NOT_REQUIRED: Text extraction is not needed for this file
    """

    SUBMITTED = "SUBMITTED"
    IN_PROGRESS = "IN_PROGRESS"
    FAILED = "FAILED"
    SUCCEEDED = "SUCCEEDED"
    NOT_REQUIRED = "NOT_REQUIRED"


class DocumentProcessingState(Enum):
    """
    Enum class representing the various states of document processing pipeline.

    Attributes:
        NOT_STARTED: Initial state before job begins
        IN_PROGRESS: Job is currently running
        FILENAME_NOT_SUPPORTED: The filename format is not supported
        FILE_EXTENSION_NOT_SUPPORTED: The file extension is not supported for text extraction
        FAILED: Job failed to complete
        SUCCEEDED: Job completed successfully
    """

    NOT_STARTED = "NOT_STARTED"
    IN_PROGRESS = "IN_PROGRESS"
    FILENAME_NOT_SUPPORTED = "FILENAME_NOT_SUPPORTED"
    FILE_EXTENSION_NOT_SUPPORTED = "FILE_EXTENSION_NOT_SUPPORTED"
    FAILED = "FAILED"
    SUCCEEDED = "SUCCEEDED"
