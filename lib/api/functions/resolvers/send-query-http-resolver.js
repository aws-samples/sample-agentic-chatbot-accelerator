// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import { util } from "@aws-appsync/utils";

/**
 * HTTP resolver for sending queries via SNS
 * Uses direct SNS HTTP API calls instead of Lambda for lower latency
 */
export function request(ctx) {
    const topicArn = ctx.env.messagesTopicArn;
    const { data } = ctx.arguments;
    const message = JSON.parse(data);

    // Set default values
    if (!message.direction) {
        message.direction = "IN";
    }
    if (!message.framework) {
        message.framework = "AGENT_CORE";
    }
    message.userId = ctx.identity.sub;

    return publishToSNSRequest(topicArn, message);
}

export function response(ctx) {
    const result = ctx.result;
    if (result.statusCode === 200) {
        // Convert the XML response to a JavaScript object
        const body = util.xml.toMap(result.body);
        return body.PublishResponse.PublishResult;
    }
    util.appendError(result.body, `${result.statusCode}`);
}

function publishToSNSRequest(topicArn, message) {
    const arn = util.urlEncode(topicArn);
    const encodedMessage = util.urlEncode(JSON.stringify(message));
    const parts = [
        "Action=Publish",
        "Version=2010-03-31",
        `TopicArn=${arn}`,
        `Message=${encodedMessage}`,
    ];
    const body = parts.join("&");
    return {
        method: "POST",
        resourcePath: "/",
        params: {
            body,
            headers: {
                "content-type": "application/x-www-form-urlencoded",
            },
        },
    };
}
