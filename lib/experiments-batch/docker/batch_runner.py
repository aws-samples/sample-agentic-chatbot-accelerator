#!/usr/bin/env python3
# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0
# ---------------------------------------------------------------------------- #
"""
AWS Batch job runner for experiment generation.
Standalone script for generating synthetic test cases.
"""

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

import boto3
from botocore.exceptions import ClientError
from strands_evals.generators import ExperimentGenerator


def update_experiment_status(
    experiment_id: str,
    user_id: str,
    status: str,
    error_message: str = None,
    s3_uri: str = None,
    num_cases_generated: int = None,
):
    """Update experiment status in DynamoDB."""
    dynamodb = boto3.resource("dynamodb")
    table_name = os.environ["EXPERIMENTS_TABLE_NAME"]
    table = dynamodb.Table(table_name)
    update_expr = "SET #status = :status, UpdatedAt = :updatedAt"
    expr_attr_names = {"#status": "Status"}
    expr_attr_values = {
        ":status": status,
        ":updatedAt": datetime.now(timezone.utc).isoformat(),
        ":userId": user_id,
    }
    if error_message:
        update_expr += ", ErrorMessage = :errorMessage"
        expr_attr_values[":errorMessage"] = error_message

    if s3_uri:
        update_expr += ", GeneratedCasesS3Url = :s3Uri"
        expr_attr_values[":s3Uri"] = s3_uri

    if num_cases_generated is not None:
        update_expr += ", GeneratedCasesCount = :numCases"
        expr_attr_values[":numCases"] = num_cases_generated

    try:
        table.update_item(
            Key={"ExperimentId": experiment_id, "UserId": user_id},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_attr_names,
            ExpressionAttributeValues=expr_attr_values,
            ConditionExpression="UserId = :userId",
        )
        print(f"Updated experiment {experiment_id} status to {status}")
    except ClientError as e:
        print(f"Error updating experiment status: {e}")
        raise


def get_experiment(experiment_id: str, user_id: str) -> Dict[str, Any]:
    """Retrieve experiment from DynamoDB."""
    dynamodb = boto3.resource("dynamodb")
    table_name = os.environ["EXPERIMENTS_TABLE_NAME"]
    table = dynamodb.Table(table_name)
    try:
        response = table.get_item(
            Key={"ExperimentId": experiment_id, "UserId": user_id}
        )
        return response.get("Item")
    except ClientError as e:
        print(f"Error retrieving experiment: {e}")
        raise


def upload_to_s3(experiment_id: str, user_id: str, test_cases: List[Any]) -> str:
    """Upload generated test cases to S3."""
    s3_client = boto3.client("s3")
    bucket_name = os.environ["EXPERIMENTS_BUCKET_NAME"]
    key = f"experiments/generated-cases/{user_id}/{experiment_id}/cases.json"

    # Convert test cases to JSON
    cases_data = []
    for case in test_cases:
        case_dict = {
            "caseId": str(uuid.uuid4()),
            "name": case.name if hasattr(case, "name") else None,
            "input": case.input,
            "expected_output": case.expected_output
            if hasattr(case, "expected_output")
            else None,
            "metadata": case.metadata if hasattr(case, "metadata") else {},
        }
        cases_data.append(case_dict)

    try:
        s3_client.put_object(
            Bucket=bucket_name,
            Key=key,
            Body=json.dumps(cases_data, indent=2),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )
        s3_uri = f"s3://{bucket_name}/{key}"
        print(f"Uploaded {len(cases_data)} test cases to {s3_uri}")
        return s3_uri
    except ClientError as e:
        print(f"Error uploading to S3: {e}")
        raise


async def run_experiment_generation(experiment_id: str, user_id: str):
    """Main experiment generation logic."""
    print(f"Starting experiment generation for {experiment_id}")

    try:
        # Update status to RUNNING
        update_experiment_status(experiment_id, user_id, "RUNNING")

        # Retrieve experiment configuration
        experiment = get_experiment(experiment_id, user_id)
        if not experiment:
            raise ValueError(f"Experiment {experiment_id} not found")

        print(f"Retrieved experiment config: {experiment}")

        # Extract configuration
        context = experiment["Context"]
        task_description = experiment["TaskDescription"]
        num_cases = int(experiment["NumCases"])
        num_topics = int(experiment["NumTopics"])
        model_id = experiment.get("ModelId", "global.amazon.nova-2-lite-v1:0")

        print(
            f"Generating {num_cases} test cases across {num_topics} topics using model {model_id}"
        )

        # Initialize ExperimentGenerator
        generator = ExperimentGenerator[str, str](
            input_type=str,
            output_type=str,
            include_expected_output=True,
            include_expected_trajectory=True,
            include_metadata=True,
            model=model_id,
        )

        # Generate test cases
        experiment_obj = await generator.from_context_async(
            context=context,
            task_description=task_description,
            num_cases=num_cases,
            num_topics=num_topics,
        )

        test_cases = experiment_obj.cases
        print(f"Generated {len(test_cases)} test cases")

        # Upload to S3
        s3_uri = upload_to_s3(experiment_id, user_id, test_cases)

        # Update status to COMPLETED
        update_experiment_status(
            experiment_id,
            user_id,
            "COMPLETED",
            s3_uri=s3_uri,
            num_cases_generated=len(test_cases),
        )

        print(f"Experiment {experiment_id} completed successfully")
        return {
            "status": "COMPLETED",
            "s3_uri": s3_uri,
            "num_cases": len(test_cases),
        }

    except Exception as e:
        error_msg = str(e)
        print(f"Error generating experiment: {error_msg}")
        update_experiment_status(
            experiment_id, user_id, "FAILED", error_message=error_msg
        )
        raise


def main():
    """Entry point for Batch job."""
    # Get job parameters from environment
    experiment_id = os.environ.get("EXPERIMENT_ID")
    user_id = os.environ.get("USER_ID")

    if not experiment_id or not user_id:
        print("Error: EXPERIMENT_ID and USER_ID must be set")
        sys.exit(1)

    print(f"Batch job started for experiment {experiment_id}, user {user_id}")

    try:
        # Run async generation
        result = asyncio.run(run_experiment_generation(experiment_id, user_id))
        print(f"Job completed successfully: {result}")
        sys.exit(0)
    except Exception as e:
        print(f"Job failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
