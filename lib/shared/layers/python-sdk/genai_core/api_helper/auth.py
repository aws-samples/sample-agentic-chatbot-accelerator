# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
from __future__ import annotations

from functools import wraps
from typing import TYPE_CHECKING, Callable, Optional

from genai_core.exceptions import UserNotFoundException

if TYPE_CHECKING:
    from aws_lambda_powertools.event_handler.graphql_appsync.router import Router


def get_user_id(router: Router) -> Optional[str]:
    """Get the user ID from the AppSync event identity.

    Args:
        router (Router): The AppSync router instance containing the current event

    Returns:
        Optional[str]: The user ID (sub) from the identity if present, otherwise None
    """
    user_id = router.current_event.get("identity", {}).get("sub")

    return user_id


def fetch_user_id(router: Router) -> Callable:
    """Decorator factory that creates a decorator to fetch the user ID from the AppSync event.

    Args:
        router (Router): The AppSync router instance containing the current event

    Returns:
        Callable: A decorator that wraps functions to include the user_id argument
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            user_id = get_user_id(router)
            if user_id is None:
                raise UserNotFoundException()
            return func(user_id=user_id, *args, **kwargs)

        return wrapper

    return decorator
