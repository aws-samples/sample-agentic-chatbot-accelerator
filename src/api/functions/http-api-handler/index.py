# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from __future__ import annotations

from typing import TYPE_CHECKING, Dict

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import AppSyncResolver
from aws_lambda_powertools.logging import correlation_paths
from genai_core.exceptions import AcaException
from pydantic import ValidationError
from routes.ai_tools import router as ai_tools_router
from routes.feedback import router as feedback_router
from routes.sessions import router as sessions_router

if TYPE_CHECKING:
    from aws_lambda_powertools.utilities.typing import LambdaContext

# -------- Lambda PT Logger and Tracing -------- #
SERVICE_ID = "graphQL-syncOpsHandler"
tracer = Tracer(service=SERVICE_ID)
logger = Logger(service=SERVICE_ID)
# ---------------------------------------------- #


# ---------------- API Routes ---------------- #
app = AppSyncResolver()
app.include_router(sessions_router)
app.include_router(feedback_router)
app.include_router(ai_tools_router)
# -------------------------------------------- #


@logger.inject_lambda_context(
    log_event=False, correlation_id_path=correlation_paths.APPSYNC_RESOLVER
)
@tracer.capture_method
def handler(event: Dict, context: LambdaContext):
    try:
        logger.info(
            "Incoming API request",
            extra={
                "payload": {
                    "fieldName": event.get("info", {}).get("fieldName"),
                    "arguments": event.get("arguments"),
                    "identity": event.get("identity"),
                }
            },
        )
        return app.resolve(event, context)
    except ValidationError as e:
        errors = e.errors(include_url=False, include_context=False, include_input=False)
        logger.warning("Validation error", errors=errors)
        raise ValueError(f"Invalid request. Details: {errors}")
    except AcaException as e:
        logger.warning(str(e))
        raise e
    except Exception as e:
        logger.exception(e)
        raise RuntimeError("Something went wrong")
