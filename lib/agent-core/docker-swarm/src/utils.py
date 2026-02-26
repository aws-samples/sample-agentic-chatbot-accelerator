# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
# TODO: Remove code duplication - consider moving shared code to a common module
import re
from typing import Optional

from pydantic import BaseModel, ValidationError


def deserialize(value: str, object_type: type[BaseModel]) -> BaseModel:
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
