// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
export function request(ctx) {
    return {
        payload: {
            agentName: ctx.arguments.agentName,
        },
    };
}

export function response(ctx) {
    return ctx.result;
}
