/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
Evaluation Module - Outputs
*/

output "operations" {
  description = "List of GraphQL operations handled by the evaluation module"
  value = [
    "listEvaluators",
    "getEvaluator",
    "createEvaluator",
    "updateEvaluator",
    "deleteEvaluator",
    "startEvaluatorRun",
    "deleteEvaluatorRun",
    "runEvaluation",
    "listEvaluatorRuns",
    "getEvaluatorRun",
    "getEvaluatorTestCases",
    # Resolved by this module's None data source, so the proxy loop must not claim
    # them. receiveEvaluationUpdate is defensive: that loop reads the Query and
    # Mutation blocks only, so no Subscription was ever proxied.
    "publishEvaluationUpdate",
    "receiveEvaluationUpdate",
  ]
}

output "evaluations_bucket_name" {
  description = "Name of the S3 bucket for evaluation data"
  value       = aws_s3_bucket.evaluations.id
}

output "evaluations_bucket_arn" {
  description = "ARN of the S3 bucket for evaluation data"
  value       = aws_s3_bucket.evaluations.arn
}

output "evaluation_queue_url" {
  description = "URL of the SQS evaluation queue"
  value       = aws_sqs_queue.evaluation.url
}

output "evaluation_queue_arn" {
  description = "ARN of the SQS evaluation queue"
  value       = aws_sqs_queue.evaluation.arn
}

output "evaluation_resolver_function_name" {
  description = "Name of the evaluation resolver Lambda function"
  value       = aws_lambda_function.evaluation_resolver.function_name
}

output "evaluation_executor_function_name" {
  description = "Name of the evaluation executor Lambda function"
  value       = aws_lambda_function.evaluation_executor.function_name
}
