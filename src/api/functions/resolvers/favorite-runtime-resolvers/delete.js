// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { util } from "@aws-appsync/utils";
export function request(ctx) {
    const userId = ctx.identity.sub;
    return {
        operation: "DeleteItem",
        key: util.dynamodb.toMapValues({ UserId: userId }),
    };
}

export function response(ctx) {
    if (ctx.error) {
        util.error(ctx.error.message, ctx.error.type);
    }

    return ctx.result;
}
