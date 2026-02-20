/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
WebSocket Backend Module - AppSync Resolvers

Creates:
- sendQuery: HTTP resolver for SNS direct publishing
- publishResponse: None data source relay resolver
- receiveMessages: Subscription resolver
*/

locals {
  resolver_path = "${path.module}/../../../lib/api/functions/resolvers"
}

# -----------------------------------------------------------------------------
# HTTP Data Source for SNS (direct API call - no Lambda)
# Lower latency, reduced cost vs Lambda-based approach
# -----------------------------------------------------------------------------

resource "aws_appsync_datasource" "sns_http" {
  api_id = var.appsync_api_id
  name   = "${replace(local.name_prefix, "-", "_")}_snsHttpDataSource"
  type   = "HTTP"

  http_config {
    endpoint = "https://sns.${data.aws_region.current.id}.amazonaws.com/"

    authorization_config {
      authorization_type = "AWS_IAM"

      aws_iam_config {
        signing_region       = data.aws_region.current.id
        signing_service_name = "sns"
      }
    }
  }

  service_role_arn = aws_iam_role.sns_http_datasource.arn
}

# IAM role for HTTP data source to publish to SNS
resource "aws_iam_role" "sns_http_datasource" {
  name = "${local.name_prefix}-appsync-sns-http-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "appsync.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-appsync-sns-http-role"
  })
}

data "aws_iam_policy_document" "sns_publish" {
  statement {
    sid    = "SNSPublish"
    effect = "Allow"
    actions = [
      "sns:Publish"
    ]
    resources = [aws_sns_topic.messages.arn]
  }
}

resource "aws_iam_role_policy" "sns_http_publish" {
  name   = "${local.name_prefix}-appsync-sns-publish"
  role   = aws_iam_role.sns_http_datasource.id
  policy = data.aws_iam_policy_document.sns_publish.json
}

# -----------------------------------------------------------------------------
# sendQuery Resolver (HTTP -> SNS)
# Direct HTTP call to SNS API for low-latency message sending
# Uses original CDK resolver file with string replacement for topic ARN
# (Avoids code duplication since Terraform doesn't support AppSync env vars)
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "send_query" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "sendQuery"
  data_source = aws_appsync_datasource.sns_http.name
  kind        = "UNIT"

  # Read the original CDK resolver and replace ctx.env.messagesTopicArn with actual ARN
  # This avoids code duplication while working around Terraform's lack of AppSync env var support
  code = replace(
    file("${local.resolver_path}/send-query-http-resolver.js"),
    "ctx.env.messagesTopicArn",
    "\"${aws_sns_topic.messages.arn}\""
  )

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

# -----------------------------------------------------------------------------
# publishResponse Resolver (None data source - relay)
# Used by outgoing message handler Lambda to publish responses
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "publish_response" {
  api_id      = var.appsync_api_id
  type        = "Mutation"
  field       = "publishResponse"
  data_source = aws_appsync_datasource.websocket_none.name
  kind        = "UNIT"

  code = file("${local.resolver_path}/publish-response-resolver.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

# -----------------------------------------------------------------------------
# receiveMessages Subscription Resolver
# Subscription for real-time message delivery to clients
# -----------------------------------------------------------------------------

resource "aws_appsync_resolver" "receive_messages" {
  api_id      = var.appsync_api_id
  type        = "Subscription"
  field       = "receiveMessages"
  data_source = aws_appsync_datasource.websocket_none.name
  kind        = "UNIT"

  code = file("${local.resolver_path}/subscribe-resolver.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

# NOTE: AppSync environment variables must be set on the aws_appsync_graphql_api resource
# The sendQuery resolver expects ctx.env.messagesTopicArn to be available
# This is handled via the appsync module's environment_variables input
