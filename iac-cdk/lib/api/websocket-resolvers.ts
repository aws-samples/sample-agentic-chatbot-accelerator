// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import * as path from "path";

import * as appsync from "aws-cdk-lib/aws-appsync";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";

interface WebsocketResolversProps {
    readonly topic: sns.ITopic;
    readonly userPool: UserPool;
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly api: appsync.GraphqlApi;
}

/**
 * WebsocketResolvers - Manages AppSync resolvers for real-time communication
 *
 * After the Direct WebSocket migration, the sendQuery resolver was removed.
 * Chat messages now flow directly via WebSocket to AgentCore containers.
 *
 * Remaining resolvers:
 *  - publishResponse: Publishes AI-rephrased tool descriptions to browser
 *  - receiveMessages: Subscription for receiving tool descriptions (side-channel)
 */
export class WebsocketResolvers extends Construct {
    constructor(scope: Construct, id: string, props: WebsocketResolversProps) {
        super(scope, id);

        const noneDataSource = props.api.addNoneDataSource("none", {
            name: "relay-source",
        });
        props.api.createResolver("publish-response-resolver", {
            typeName: "Mutation",
            fieldName: "publishResponse",
            code: appsync.Code.fromAsset(
                path.join(
                    __dirname,
                    "../../../src/api/functions/resolvers/publish-response-resolver.js",
                ),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
        props.api.createResolver("subscription-resolver", {
            typeName: "Subscription",
            fieldName: "receiveMessages",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "../../../src/api/functions/resolvers/subscribe-resolver.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
    }
}
