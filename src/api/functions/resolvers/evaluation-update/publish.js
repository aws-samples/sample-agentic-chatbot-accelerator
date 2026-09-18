// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
export function request(ctx) {
    return {
        payload: {
            evaluatorId: ctx.arguments.evaluatorId,
            runId: ctx.arguments.runId,
            status: ctx.arguments.status,
        },
    };
}

export function response(ctx) {
    return ctx.result;
}
