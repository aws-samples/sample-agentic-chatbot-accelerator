# ----------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# ----------------------------------------------------------------------- #


import os
from dataclasses import dataclass
from typing import Any, Dict

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import (
    CloudFormationCustomResourceEvent,
    event_source,
)
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.client import BaseClient
from botocore.exceptions import ClientError

# ------------------------- Lambda Powertools ------------------------ #
logger = Logger(service="aca-cleanUpResources")
tracer = Tracer(service="aca-cleanUpResources")


# ----------------------- Environment Variables ---------------------- #
# IaC-managed Knowledge Base IDs to preserve (CDK or Terraform created)
IAC_KNOWLEDGE_BASE_IDS = (
    set(os.environ.get("IAC_KNOWLEDGE_BASE_IDS", "").split(","))
    if os.environ.get("IAC_KNOWLEDGE_BASE_IDS")
    else set()
)
# Backwards compatibility with CDK deployments
if not IAC_KNOWLEDGE_BASE_IDS and os.environ.get("CDK_KNOWLEDGE_BASE_IDS"):
    IAC_KNOWLEDGE_BASE_IDS = set(os.environ["CDK_KNOWLEDGE_BASE_IDS"].split(","))

# IaC-managed EventBridge rule names to preserve
IAC_RULE_NAMES = (
    set(os.environ.get("IAC_RULE_NAMES", "").split(","))
    if os.environ.get("IAC_RULE_NAMES")
    else set()
)
# Backwards compatibility with CDK deployments
if not IAC_RULE_NAMES and os.environ.get("CDK_RULE_NAMES"):
    IAC_RULE_NAMES = set(os.environ["CDK_RULE_NAMES"].split(","))

KB_INVENTORY_TABLE_NAME = os.environ.get("KB_INVENTORY_TABLE")

STACK_TAG = os.environ.get("STACK_TAG", "")
ENVIRONMENT_TAG = os.environ.get("ENVIRONMENT_TAG", "")

# Owner tag value to preserve (resources created by IaC tool)
# For CDK deployments: "CDK", for Terraform: "Terraform"
IAC_OWNER_TAG = os.environ.get("IAC_OWNER_TAG", "CDK")

# Feature flag to check if Knowledge Base is enabled
KB_ENABLED = bool(KB_INVENTORY_TABLE_NAME)

# -------------------------------------------------------------------- #

# --------------------------- AWS CLIENTS ---------------------------- #
DYNAMODB_RESOURCE = boto3.resource("dynamodb")
BEDROCK_AGENT_CLIENT = boto3.client("bedrock-agent")
EVENTS_CLIENT = boto3.client("events")
BAC_CLIENT = boto3.client("bedrock-agentcore-control")


# Only create table reference if KB is enabled
KB_TABLE = DYNAMODB_RESOURCE.Table(KB_INVENTORY_TABLE_NAME) if KB_ENABLED else None  # type: ignore
# -------------------------------------------------------------------- #


@tracer.capture_method
def _process_kb_item(
    item: Dict[str, Any],
    cdk_kb_ids: set,
    cdk_rule_names: set,
    processed_kbs: set,
    processed_rules: set,
    bedrock: BaseClient,
    events: BaseClient,
) -> bool:
    """
    Process a single knowledge base inventory item.

    Returns:
        bool: True if resource was cleaned up, False if preserved
    """
    kb_id = item.get("KnowledgeBaseId")
    data_source_id = item.get("DataSourceId")
    rule_name = item.get("S3DataProcessingRuleName")

    logger.info(
        "Processing KB item",
        extra={
            "kbProcessing": {
                "knowledgeBaseId": kb_id,
                "dataSourceId": data_source_id,
                "ruleName": rule_name,
            }
        },
    )

    # Check if this is an IaC-managed knowledge base (by KB ID)
    if kb_id in cdk_kb_ids:
        logger.info(f"Preserving IaC-managed knowledge base: {kb_id}")
        return False  # Resource preserved

    # This is a user-created knowledge base - clean it up
    logger.info(f"Cleaning up user-created knowledge base: {kb_id}")

    # Handle knowledge base deletion (avoid duplicates)
    if kb_id not in processed_kbs:
        try:
            # Check KB status before attempting deletion
            logger.info(f"Checking status of knowledge base: {kb_id}")
            kb_info = bedrock.get_knowledge_base(knowledgeBaseId=kb_id)
            status = kb_info["knowledgeBase"]["status"]

            if status == "ACTIVE":
                # Delete the knowledge base
                logger.info(f"Deleting knowledge base: {kb_id}")
                bedrock.delete_knowledge_base(knowledgeBaseId=kb_id)
                logger.info(f"Successfully deleted knowledge base: {kb_id}")
            elif status in [
                "CREATING",
                "DELETING",
                "UPDATING",
                "FAILED",
                "DELETE_UNSUCCESSFUL",
            ]:
                logger.info(f"Skipping KB {kb_id} - status:{status}")
            else:
                logger.warning(
                    f"KB {kb_id} in unexpected status: {status}, skipping deletion"
                )

            processed_kbs.add(kb_id)

        except ClientError as e:
            logger.warning(
                "Failed to delete knowledge base. KB might have already been deleted.",
                extra={
                    "deletionError": {
                        "knowledgeBaseId": kb_id,
                        "error": str(e),
                        "errorCode": e.response.get("Error", {}).get("Code"),
                    }
                },
            )
            processed_kbs.add(kb_id)  # Mark as processed to avoid retry
    else:
        logger.info(f"Skipping already processed knowledge base: {kb_id}")

    # Handle EventBridge rule deletion (avoid duplicates)
    # Only delete rules that are NOT CDK-created (exact name matching)
    if rule_name and rule_name not in processed_rules:
        # Check if this is an IaC-managed rule (by exact rule name)
        if rule_name in cdk_rule_names:
            logger.info(f"Preserving IaC-managed EventBridge rule: {rule_name}")
        else:
            # This is a user-created rule - delete it
            try:
                logger.info(f"Deleting user-created EventBridge rule: {rule_name}")

                # First, remove all targets from the rule
                try:
                    targets_response = events.list_targets_by_rule(Rule=rule_name)
                    if targets_response.get("Targets"):
                        target_ids = [
                            target["Id"] for target in targets_response["Targets"]
                        ]
                        events.remove_targets(Rule=rule_name, Ids=target_ids)
                        logger.info(f"Removed targets from rule: {rule_name}")
                except ClientError as e:
                    logger.error(
                        "Failed to remove targets from rule",
                        extra={
                            "targetRemovalError": {
                                "ruleName": rule_name,
                                "error": str(e),
                                "errorCode": e.response.get("Error", {}).get("Code"),
                            }
                        },
                    )

                # Then delete the rule
                events.delete_rule(Name=rule_name)
                logger.info(f"Successfully deleted EventBridge rule: {rule_name}")

            except ClientError as e:
                logger.error(
                    "Failed to delete EventBridge rule",
                    extra={
                        "deletionError": {
                            "ruleName": rule_name,
                            "error": str(e),
                            "errorCode": e.response.get("Error", {}).get("Code"),
                        }
                    },
                )
                # Continue with other cleanup operations

        processed_rules.add(rule_name)
    elif rule_name:
        logger.info(f"Skipping already processed EventBridge rule: {rule_name}")

    return True  # Increment cleanup count, no preserved count increment


@tracer.capture_method
def _remove_runtimes() -> None:
    @dataclass
    class Runtime:
        arn: str
        identifier: str

    try:
        agent_runtimes: list[Runtime] = []

        response = BAC_CLIENT.list_agent_runtimes(maxResults=100)
        agent_runtimes.extend(
            [
                Runtime(
                    arn=elem.get("agentRuntimeArn", ""),
                    identifier=elem.get("agentRuntimeId", ""),
                )
                for elem in response.get("agentRuntimes", [])
            ]
        )
        while response.get("nextToken"):
            response = BAC_CLIENT.list_agent_runtimes(maxResults=100)
            agent_runtimes.extend(
                [
                    Runtime(
                        arn=elem.get("agentRuntimeArn", ""),
                        identifier=elem.get("agentRuntimeId", ""),
                    )
                    for elem in response.get("agentRuntimes", [])
                ]
            )
    except ClientError as err:
        logger.error(
            "Failed to fetch AgentCore Runtimes", extra={"rawErrorMessage": str(err)}
        )
        logger.warning("Continuing with stack deletion despite cleanup errors")
        return

    logger.info(f"Retrieved {len(agent_runtimes)} AgentCore runtimes")

    for runtime in agent_runtimes:
        try:
            response = BAC_CLIENT.list_tags_for_resource(resourceArn=runtime.arn)
            tags = response.get("tags", {})
        except ClientError as err:
            logger.error(
                f"Failed to get tags of {runtime.identifier} to check if needs to be deleted",
                extra={"rawErrorMessage": str(err)},
            )
            logger.warning("Continuing with stack deletion despite cleanup errors")
            continue

        try:
            if (
                tags.get("Environment", "_aca") == ENVIRONMENT_TAG
                and tags.get("Stack", "_tag") == STACK_TAG
                and tags.get("Owner") != IAC_OWNER_TAG
            ):
                logger.info(
                    f"Runtime {runtime.identifier} was created from the application and needs cleanup"
                )
                # TODO - think about if/how to handle the following
                # ! the following will fail if runtimes has custom endpoints attached
                BAC_CLIENT.delete_agent_runtime(agentRuntimeId=runtime.identifier)
                logger.info(
                    f"Deletion of runtime {runtime.identifier} correctly started"
                )

            # Environment: dev
            # Stack: aca
        except ClientError as err:
            logger.error(
                f"Failed to delete {runtime.identifier}",
                extra={"rawErrorMessage": str(err)},
            )
            logger.warning("Continuing with stack deletion despite cleanup errors")
            continue


@tracer.capture_method
def _remove_memories() -> None:
    @dataclass
    class Memory:
        arn: str
        identifier: str

    try:
        memories: list[Memory] = []

        response = BAC_CLIENT.list_memories(maxResults=100)
        memories.extend(
            [
                Memory(
                    arn=elem.get("arn", ""),
                    identifier=elem.get("id", ""),
                )
                for elem in response.get("memories", [])
            ]
        )
        while response.get("nextToken"):
            response = BAC_CLIENT.list_memories(
                maxResults=100, nextToken=response["nextToken"]
            )
            memories.extend(
                [
                    Memory(
                        arn=elem.get("arn", ""),
                        identifier=elem.get("id", ""),
                    )
                    for elem in response.get("memories", [])
                ]
            )
    except ClientError as err:
        logger.error(
            "Failed to fetch AgentCore Memories", extra={"rawErrorMessage": str(err)}
        )
        logger.warning("Continuing with stack deletion despite cleanup errors")
        return

    logger.info(f"Retrieved {len(memories)} AgentCore memories")

    for memory in memories:
        try:
            response = BAC_CLIENT.list_tags_for_resource(resourceArn=memory.arn)
            tags = response.get("tags", {})
        except ClientError as err:
            logger.error(
                f"Failed to get tags of {memory.identifier} to check if needs to be deleted",
                extra={"rawErrorMessage": str(err)},
            )
            logger.warning("Continuing with stack deletion despite cleanup errors")
            continue

        try:
            if (
                tags.get("Environment", "_aca") == ENVIRONMENT_TAG
                and tags.get("Stack", "_tag") == STACK_TAG
                and tags.get("Owner") != IAC_OWNER_TAG
            ):
                logger.info(
                    f"Memory {memory.identifier} was created from the application and needs cleanup"
                )
                BAC_CLIENT.delete_memory(memoryId=memory.identifier)
                logger.info(f"Deletion of memory {memory.identifier} correctly started")
        except ClientError as err:
            logger.error(
                f"Failed to delete {memory.identifier}",
                extra={"rawErrorMessage": str(err)},
            )
            logger.warning("Continuing with stack deletion despite cleanup errors")
            continue


@tracer.capture_method
def on_delete():
    logger.info("Running cleanup during stack deletion")

    # Skip KB cleanup if KB feature is not enabled
    if not KB_ENABLED or KB_TABLE is None:
        logger.info("Knowledge Base feature not enabled, skipping KB cleanup")
    else:
        try:
            logger.info(
                "IaC-managed resources to preserve",
                extra={
                    "preservationConfig": {
                        "knowledgeBaseIds": list(IAC_KNOWLEDGE_BASE_IDS),
                        "ruleNames": list(IAC_RULE_NAMES),
                        "ownerTag": IAC_OWNER_TAG,
                    }
                },
            )

            # Scan the knowledge base inventory table
            logger.info("Scanning knowledge base inventory table")
            response = KB_TABLE.scan()

            cleanup_count = 0
            processed_kbs = set()  # Track processed KBs to avoid duplicates
            processed_rules = set()  # Track processed rules to avoid duplicates

            for item in response["Items"]:
                resource_cleaned = _process_kb_item(
                    item,
                    IAC_KNOWLEDGE_BASE_IDS,
                    IAC_RULE_NAMES,
                    processed_kbs,
                    processed_rules,
                    BEDROCK_AGENT_CLIENT,
                    EVENTS_CLIENT,
                )
                cleanup_count += resource_cleaned

            # Handle pagination if there are more items
            while "LastEvaluatedKey" in response:
                logger.info("Scanning next page of knowledge base inventory")
                response = KB_TABLE.scan(ExclusiveStartKey=response["LastEvaluatedKey"])

                for item in response["Items"]:
                    resource_cleaned = _process_kb_item(
                        item,
                        IAC_KNOWLEDGE_BASE_IDS,
                        IAC_RULE_NAMES,
                        processed_kbs,
                        processed_rules,
                        BEDROCK_AGENT_CLIENT,
                        EVENTS_CLIENT,
                    )
                    cleanup_count += resource_cleaned

            # Calculate preserved count
            total_items = len(response.get("Items", []))
            preserved_count = total_items - cleanup_count

            logger.info(
                "KB cleanup completed successfully",
                extra={
                    "cleanupSummary": {
                        "cleanedUp": cleanup_count,
                        "preserved": preserved_count,
                    }
                },
            )

        except ClientError as e:
            logger.error(
                "Error during KB cleanup",
                extra={
                    "cleanupError": {
                        "error": str(e),
                        "errorCode": e.response.get("Error", {}).get("Code"),
                    }
                },
            )
            # Continue with stack deletion even if cleanup fails
            logger.warning("Continuing with stack deletion despite cleanup errors")
        except Exception as e:
            logger.error(
                "Unexpected error during KB cleanup",
                extra={"unexpectedError": {"error": str(e), "type": type(e).__name__}},
            )
            # Continue with stack deletion even if cleanup fails
            logger.warning("Continuing with stack deletion despite cleanup errors")

    _remove_runtimes()
    _remove_memories()

    # Return success response
    return {
        "status": 200,
        "Data": {"Message": "Cleanup operation completed"},
    }


@event_source(data_class=CloudFormationCustomResourceEvent)
def handler(
    event: CloudFormationCustomResourceEvent, _: LambdaContext
) -> Dict[str, Any]:
    """
    Custom resource handler for cleanup operations during stack deletion.
    Only runs when RequestType is 'Delete'.

    This Lambda cleans up user-created knowledge bases and EventBridge rules
    while preserving IaC-managed resources (CDK or Terraform created).
    """

    logger.info(f"Received event: {event}")

    request_type = event.request_type

    if request_type == "Delete":
        return on_delete()

    msg = f"No action needed for RequestType: {request_type}"
    logger.info(msg)
    return {
        "status": 200,
        "Data": {"Message": msg},
    }
