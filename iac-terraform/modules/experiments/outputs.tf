/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Experiments Module - Outputs
*/

output "operations" {
  description = "List of GraphQL operations handled by the experiments module"
  value = [
    "listExperiments",
    "getExperiment",
    "getExperimentPresignedUrl",
    "createExperiment",
    "updateExperiment",
    "deleteExperiment",
    "runExperiment",
  ]
}

output "experiment_resolver_function_name" {
  description = "Name of the experiment resolver Lambda function"
  value       = aws_lambda_function.experiment_resolver.function_name
}

output "batch_job_queue_name" {
  description = "Name of the Batch job queue"
  value       = aws_batch_job_queue.experiments.name
}

output "batch_job_definition_name" {
  description = "Name of the Batch job definition"
  value       = aws_batch_job_definition.experiments.name
}
