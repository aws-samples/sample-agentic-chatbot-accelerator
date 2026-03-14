/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

/**
 * AppSync request mapping template for GraphQL mutation
 * Transforms incoming GraphQL arguments into the expected payload format
 * @param {Object} ctx - The AppSync context object containing the GraphQL arguments
 * @returns {Object} Formatted payload with data, sessionId and userId
 */
export function request(ctx) {
    return {
        payload: {
            data: ctx.arguments.data,
            sessionId: ctx.arguments.sessionId,
            userId: ctx.arguments.userId,
        },
    };
}

/**
 * AppSync response mapping template for GraphQL mutation
 * Returns the raw result from the resolver
 * @param {Object} ctx - The AppSync context object containing the resolver result
 * @returns {*} The unmodified resolver result
 */
export function response(ctx) {
    return ctx.result;
}
