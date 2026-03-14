# Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ----------------------------------------------------------------------
from hashlib import blake2b


def generate_doc_hash(document_key: str, prefix_level: int = 0) -> str:
    """Generate a hash string from a document key.

    Args:
        document_key (str): The document key to generate hash from
        prefix_level (int, optional): Number of path segments to skip from start. Defaults to 0.

    Returns:
        str: A 32-character hash string formatted as 4 groups of 8 characters separated by hyphens

    """
    hash_val = blake2b(digest_size=16)
    hash_val.update("/".join(document_key.split("/")[prefix_level:]).encode("UTF-8"))
    h_as_str = hash_val.hexdigest()
    return f"{h_as_str[0:8]}-{h_as_str[8:16]}-{h_as_str[16:24]}-{h_as_str[24:32]}"
