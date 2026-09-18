// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { extensions, util } from "@aws-appsync/utils";

export function request(_) {
    return {
        payload: null,
    };
}

export function response(ctx) {
    // runId is deliberately not filtered: clients filter it themselves (FR4).
    const filter = {
        evaluatorId: { eq: ctx.args.evaluatorId },
    };
    extensions.setSubscriptionFilter(util.transform.toSubscriptionFilter(filter));
    return null;
}
