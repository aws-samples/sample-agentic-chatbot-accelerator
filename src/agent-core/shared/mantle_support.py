# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Bedrock Mantle endpoint helpers: model catalog, token minting, base URLs.

Isolated from Strands types so cache/fallback/token logic is unit-testable on its
own. Region is read from AWS_REGION (see shared/base_registry.py convention).
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

# Process-local cache of the Mantle catalog. ``None`` means "not yet fetched
# successfully" — a failed fetch leaves it None so the next call retries. A
# successful fetch (even an empty catalog) is cached for the process lifetime;
# containers are session-scoped microVMs, so this is one fetch per session.
_model_ids_cache: frozenset[str] | None = None


def get_mantle_model_ids() -> frozenset[str]:
    """Return the set of model ids served on the bedrock-mantle endpoint.

    Fetched via the OpenAI SDK ``client.models.list()`` against
    ``openai_base_url(region)``. A successful result is cached at module level
    for the process lifetime (containers are session-scoped microVMs, so one
    fetch per session). Failures are not cached, so a transient blip at
    container start does not permanently disable Mantle — the next call retries.

    There is NO static allowlist fallback: on failure the catalog is empty, so
    every id routes to Converse. A hardcoded seed set would be arbitrary,
    incomplete, and stale-prone — exactly what ADR-0003's dynamic discovery
    avoids.

    Returns:
        frozenset[str]: Mantle-served model ids verbatim as the endpoint reports
            them (short form, e.g. ``"openai.gpt-oss-20b"``; no normalization).
            Empty on fetch failure (network / auth / throttle) — never raises.
    """
    global _model_ids_cache
    if _model_ids_cache is not None:
        return _model_ids_cache

    try:
        model_ids = _fetch_model_ids()
    except Exception as exc:  # noqa: BLE001 - degrade to Converse on any failure
        logger.warning(
            "Failed to fetch the Bedrock Mantle model catalog; routing all models "
            "to Converse until the next retry: %s",
            exc,
        )
        return frozenset()

    # Cache success only (including a legitimately empty catalog).
    _model_ids_cache = model_ids
    return _model_ids_cache


def is_on_mantle(model_id: str) -> bool:
    """Return whether ``model_id`` is served on the Mantle endpoint.

    Exact string match by design (see ADR-0003): the user owns the configured
    model id. Delegates to ``get_mantle_model_ids()``.

    Args:
        model_id (str): The configured model id to test.

    Returns:
        bool: True iff ``model_id`` is an exact member of the cached Mantle
            catalog. A Mantle-listed id (e.g. ``"openai.gpt-oss-20b"``) is True;
            a cross-region inference profile or Converse-form id (e.g.
            ``"us.anthropic.claude-…"``, ``"…-v1:0"``) is absent → False.
    """
    return model_id in get_mantle_model_ids()


def mint_token(region: str) -> str:
    """Mint a short-lived Bedrock bearer token for the Mantle endpoints.

    Thin wrapper over ``aws_bedrock_token_generator.provide_token``, used as the
    ``api_key`` for both the OpenAI and Anthropic Mantle clients (one shared
    minter). Uses the standard AWS credential chain.

    Args:
        region (str): AWS region hosting the Mantle endpoint.

    Returns:
        str: A short-lived Bedrock bearer token.

    Raises:
        RuntimeError: If token minting fails (missing creds / connectivity),
            surfaced with a clear message so the container fails loudly at model
            construction rather than at first inference.
    """
    from aws_bedrock_token_generator import provide_token

    try:
        return provide_token(region=region)
    except Exception as exc:
        raise RuntimeError(
            f"Failed to mint a Bedrock bearer token for region {region!r}: {exc}"
        ) from exc


def openai_base_url(region: str) -> str:
    """Build the OpenAI-compatible Mantle base URL.

    Args:
        region (str): AWS region hosting the Mantle endpoint.

    Returns:
        str: ``https://bedrock-mantle.{region}.api.aws/v1`` (matches strands
            ``_openai_bedrock._MANTLE_BASE_URL_TEMPLATE``).
    """
    return f"https://bedrock-mantle.{region}.api.aws/v1"


def openai_passthrough_base_url(region: str) -> str:
    """Build the OpenAI-proprietary-passthrough Mantle base URL (``/openai/v1``).

    A handful of Mantle models are served only on the ``/openai/v1`` passthrough
    rather than the general Chat Completions path (``/v1``) — the newest OpenAI
    proprietary models (``openai.gpt-5.*``, Responses API) plus, per their AWS
    model cards, ``google.gemma-4-*`` and ``xai.grok-4.*`` on Chat Completions.
    Hitting ``/v1`` for those returns ``400 "model isn't supported on this
    route"`` (verified live 2026-07-28).

    Args:
        region (str): AWS region hosting the Mantle endpoint.

    Returns:
        str: ``https://bedrock-mantle.{region}.api.aws/openai/v1``.
    """
    return f"https://bedrock-mantle.{region}.api.aws/openai/v1"


def anthropic_base_url(region: str) -> str:
    """Build the Anthropic Messages Mantle base URL.

    Args:
        region (str): AWS region hosting the Mantle endpoint.

    Returns:
        str: ``https://bedrock-mantle.{region}.api.aws/anthropic`` (the Anthropic
            SDK appends ``/v1/messages``). Source:
            https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html
    """
    return f"https://bedrock-mantle.{region}.api.aws/anthropic"


def _fetch_model_ids() -> frozenset[str]:
    """Fetch the Mantle catalog from ``GET /v1/models`` via the OpenAI SDK.

    Uses the same ``openai`` client the OpenAI Mantle branch uses, pointed at
    ``openai_base_url(...)`` with a freshly minted bearer token. Isolated from
    the caching/fallback logic in ``get_mantle_model_ids`` so the network seam
    is easy to mock in tests.

    Returns:
        frozenset[str]: The model ids as reported by ``client.models.list()``
            (``data[*].id``), verbatim.
    """
    from openai import OpenAI

    active_region = os.environ["AWS_REGION"]
    client = OpenAI(
        base_url=openai_base_url(active_region),
        api_key=mint_token(active_region),
    )
    response = client.models.list()
    return frozenset(model.id for model in response.data)


def _reset_cache() -> None:
    """Clear the process-local catalog cache. Test-only seam."""
    global _model_ids_cache
    _model_ids_cache = None
