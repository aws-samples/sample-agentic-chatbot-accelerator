# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from typing import Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.parser import BaseModel, event_parser
from botocore.exceptions import ClientError

# ------------------- Lambda Powertools -------------------- #
tracer = Tracer(service="deleteAgentBundle")
logger = Logger(service="deleteAgentBundle")
# ---------------------------------------------------------- #

# --------------- Boto3 Clients/Resource ------------------- #
BAC_CLIENT = boto3.client("bedrock-agentcore-control")
# ---------------------------------------------------------- #


class InputModel(BaseModel):
    agentName: str
    # Supplied by the delete SFN, read from the summary row *before* it is
    # deleted (the summary row is gone by the time this Lambda runs). Optional
    # so pre-bundles agents (no BundleId recorded) resolve to a clean no-op.
    bundleId: Optional[str] = None


class Body(BaseModel):
    message: str
    deletedBundleId: Optional[str] = None


class OutputModel(BaseModel):
    status: int
    body: Body


@event_parser(model=InputModel)
@tracer.capture_lambda_handler
def handler(event: InputModel, _) -> dict:
    """Delete the agent's AgentCore configuration bundle by its stored bundleId.

    The delete state machine reads ``BundleId`` from the summary row and passes
    it in, then deletes the summary row itself; this Lambda calls
    ``bedrock-agentcore-control.delete_configuration_bundle`` which removes the
    bundle and all its (immutable) versions. An already-absent bundle is treated
    as success so retries and partial-failure re-runs are idempotent.

    Args:
        event: InputModel containing agentName and (optionally) bundleId.
        _: Lambda context (unused).

    Returns:
        dict: Response with status code, message, and the deleted bundleId.
    """
    if not event.bundleId:
        # Nothing recorded (e.g. an agent created before config bundles) — no
        # bundle to orphan, so this is a successful no-op.
        msg = f"No bundleId for agent {event.agentName}; nothing to delete"
        logger.info(msg)
        output = OutputModel(status=200, body=Body(message=msg))
        return output.model_dump()

    try:
        BAC_CLIENT.delete_configuration_bundle(bundleId=event.bundleId)
        msg = (
            f"Deleted configuration bundle {event.bundleId} "
            f"for agent {event.agentName}"
        )
        logger.info(msg)
        output = OutputModel(
            status=200, body=Body(message=msg, deletedBundleId=event.bundleId)
        )

    except ClientError as err:
        error_code = err.response.get("Error", {}).get("Code", "")
        if error_code == "ResourceNotFoundException":
            # Already gone — idempotent success.
            msg = (
                f"Configuration bundle {event.bundleId} already absent "
                f"for agent {event.agentName}; treating as deleted"
            )
            logger.info(msg)
            output = OutputModel(
                status=200, body=Body(message=msg, deletedBundleId=event.bundleId)
            )
        else:
            msg = (
                f"Failed to delete configuration bundle {event.bundleId} "
                f"for agent {event.agentName}"
            )
            output = OutputModel(status=400, body=Body(message=msg))
            logger.error(msg, extra={"rawErrorMessage": str(err)})
    except Exception as err:
        msg = (
            f"Unexpected error deleting configuration bundle "
            f"for agent {event.agentName}"
        )
        output = OutputModel(status=500, body=Body(message=msg))
        logger.error(msg, extra={"rawErrorMessage": str(err)})

    logger.info(
        "Lambda handler ready to return", extra={"lambdaResponse": output.model_dump()}
    )
    return output.model_dump()
