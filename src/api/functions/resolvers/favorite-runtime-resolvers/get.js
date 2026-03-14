// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { util } from "@aws-appsync/utils";
export function request(ctx) {
    const userId = ctx.identity.sub;
    return {
        operation: "GetItem",
        key: util.dynamodb.toMapValues({ UserId: userId }),
        consistentRead: false,
    };
}

export function response(ctx) {
    if (ctx.error) {
        util.error(ctx.error.message, ctx.error.type);
    }

    return ctx.result && ctx.result.AgentRuntimeId && ctx.result.EndpointName
        ? { agentRuntimeId: ctx.result.AgentRuntimeId, endpointName: ctx.result.EndpointName }
        : null;
}
