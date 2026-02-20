# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #

import json
import os
from typing import Dict, Optional

import boto3

SNS_CLIENT = boto3.client("sns")


def send_to_client(detail: Dict, topic_arn: Optional[str] = None) -> None:
    """
    Send a message to an SNS topic.

    Args:
        detail (Dict): The message details to be sent. If "direction" is not specified,
                         it will be set to "OUT".
        topic_arn (Optional[str]): The ARN of the SNS topic to publish to. If not provided,
                                  uses the MESSAGE_TOPIC_ARN environment variable.

    Returns:
        None
    """
    if not detail.get("direction"):
        detail["direction"] = "OUT"

    if not detail.get("framework"):
        detail["framework"] = "BEDROCK_MANAGED"

    if not topic_arn:
        topic_arn = os.environ["MESSAGE_TOPIC_ARN"]

    SNS_CLIENT.publish(
        TopicArn=topic_arn,
        Message=json.dumps(detail),
    )
