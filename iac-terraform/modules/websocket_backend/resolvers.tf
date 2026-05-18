/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
WebSocket Backend Module - AppSync Resolvers

After the Direct WebSocket migration, the sendQuery resolver was removed.
Chat messages now flow directly via WebSocket to AgentCore containers.

Remaining resolvers:
- publishResponse: None data source relay resolver (for AI-rephrased tool descriptions)
- receiveMessages: Subscription resolver (side-channel for tool descriptions)
*/

locals {
  resolver_path = "${path.module}/../../../src/api/functions/resolvers"
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
