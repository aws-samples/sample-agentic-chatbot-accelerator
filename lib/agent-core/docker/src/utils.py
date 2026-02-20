# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import json
import logging
import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ValidationError


def deserialize(value: str, object_type: type[BaseModel]) -> BaseModel:
    try:
        parsed_object = object_type.model_validate_json(value)
    except ValidationError as err:
        print(f"Validation error: {err}")
        raise err

    return parsed_object


class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
        }

        # Add any extra fields
        for key, value in record.__dict__.items():
            if key not in [
                "name",
                "msg",
                "args",
                "levelname",
                "levelno",
                "pathname",
                "filename",
                "module",
                "lineno",
                "funcName",
                "created",
                "msecs",
                "relativeCreated",
                "thread",
                "threadName",
                "processName",
                "process",
                "getMessage",
                "exc_info",
                "exc_text",
                "stack_info",
            ]:
                log_entry[key] = value

        return json.dumps(log_entry)


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
