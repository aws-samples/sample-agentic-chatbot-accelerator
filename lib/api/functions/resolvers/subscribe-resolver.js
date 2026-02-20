/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

import { extensions, util } from "@aws-appsync/utils";

export function request(ctx) {
    return {
        payload: null,
    };
}

/**
 * AppSync resolver response function that sets up a subscription filter
 * @param {Object} ctx - The AppSync resolver context object
 * @param {Object} ctx.identity - The caller's identity information
 * @param {string} ctx.identity.sub - The authenticated user's ID
 * @param {Object} ctx.args - The resolver arguments
 * @param {string} ctx.args.sessionId - The session ID to filter on
 * @returns {null} Returns null as this is a subscription filter setup
 */
export function response(ctx) {
    const filter = {
        and: [{ userId: { eq: ctx.identity.sub } }, { sessionId: { eq: ctx.args.sessionId } }],
    };
    extensions.setSubscriptionFilter(util.transform.toSubscriptionFilter(filter));
    return null;
}
