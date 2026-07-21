# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Single write-path primitive for AgentCore configuration bundles.

Given an agent id and its full ``AgentConfiguration`` JSON, this Lambda either
creates a new bundle (first version) or appends an immutable version to an
existing bundle (chained via ``parentVersionIds``). It returns the identifiers
the caller (SFN in T5, seeder in T7) persists into ``agentCoreSummaryTable`` —
this handler is pure control-plane and never writes DynamoDB.

Keying uses a single stable component id — the agent name, not the runtime ARN —
because the ARN does not exist yet when the bundle is first created (ADR-0002).
"""

import re
import uuid
from typing import Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="graphQL-putConfigBundle")
logger = Logger(service="graphQL-putConfigBundle")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #

# Bundle names must match ^[a-zA-Z][a-zA-Z0-9_]{0,99}$ before AWS appends its
# random suffix — so the sanitized prefix is capped at 100 chars.
BUNDLE_NAME_MAX = 100


class PutConfigBundleInput(BaseModel):
    """Input to create-or-version a bundle for one agent."""

    agentName: str  # stable component key + name-prefix source (ADR-0002)
    configurationValue: str  # full AgentConfiguration JSON, single-blob (design §6)
    bundleId: Optional[str] = None  # None -> create new bundle; set -> add a version
    parentVersionId: Optional[str] = None  # required when bundleId set
    commitMessage: Optional[str] = None


class PutConfigBundleOutput(BaseModel):
    """Identifiers persisted by the caller into agentCoreSummaryTable."""

    bundleId: str
    bundleArn: str
    versionId: str  # new immutable version -> QualifierToVersion[DEFAULT]


def sanitize_bundle_name(agent_name: str) -> str:
    """Map an agent name to a valid bundle-name prefix: ``[a-zA-Z][a-zA-Z0-9_]{0,99}``.

    Hyphens (and any other disallowed char) become underscores, a leading letter
    is guaranteed, and the result is truncated to the max length. AWS appends a
    random suffix, so this prefix need not be globally unique (ADR-0002).
    """
    # Collapse every disallowed character to an underscore.
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", agent_name)
    # Bundle names must start with a letter — prefix one when they don't.
    if not sanitized or not sanitized[0].isalpha():
        sanitized = f"a_{sanitized}"
    return sanitized[:BUNDLE_NAME_MAX]


@event_parser(model=PutConfigBundleInput)
@tracer.capture_lambda_handler
def handler(event: PutConfigBundleInput, _) -> dict:
    """Create a bundle (no ``bundleId``) or a new version (``bundleId`` + parent).

    The entire ``AgentConfiguration`` JSON is stored single-blob under one
    ``ConfigurationValue`` key, matching the container-side read path (T1).

    Args:
        event: Parsed :class:`PutConfigBundleInput`.
        _: Lambda context (unused).

    Raises:
        ValueError: If ``bundleId`` is set without ``parentVersionId``.
        ClientError: If the control-plane call fails.

    Returns:
        dict: A :class:`PutConfigBundleOutput` dump with the new bundle/version ids.
    """
    components = {
        event.agentName: {
            "configuration": {"ConfigurationValue": event.configurationValue}
        }
    }

    api_args = {
        "components": components,
        "clientToken": str(uuid.uuid4()),  # idempotency for at-least-once retries
    }
    if event.commitMessage:
        api_args["commitMessage"] = event.commitMessage

    if event.bundleId:
        # Update path: chain a new immutable version onto the existing bundle.
        if not event.parentVersionId:
            err_msg = "parentVersionId is required when bundleId is set"
            logger.error(err_msg)
            raise ValueError(err_msg)
        api_args["bundleId"] = event.bundleId
        api_args["parentVersionIds"] = [event.parentVersionId]
        api_func = BAC_CLIENT.update_configuration_bundle
        logger.info(
            "Adding a new version to configuration bundle",
            extra={"bundleId": event.bundleId, "agentName": event.agentName},
        )
    else:
        # Create path: first version of a brand-new bundle.
        api_args["bundleName"] = sanitize_bundle_name(event.agentName)
        api_func = BAC_CLIENT.create_configuration_bundle
        logger.info(
            "Creating a new configuration bundle",
            extra={"bundleName": api_args["bundleName"], "agentName": event.agentName},
        )

    try:
        response = api_func(**api_args)
    except ClientError as err:
        logger.error(
            "Failed to put configuration bundle", extra={"rawErrorMessage": str(err)}
        )
        logger.exception(err)
        raise err

    output = PutConfigBundleOutput(
        bundleId=response["bundleId"],
        bundleArn=response["bundleArn"],
        versionId=response["versionId"],
    )
    logger.info("Configuration bundle written", extra={"metadata": output.model_dump()})
    return output.model_dump()
