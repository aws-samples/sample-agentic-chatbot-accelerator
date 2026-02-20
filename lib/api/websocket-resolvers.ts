/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import * as sns from "aws-cdk-lib/aws-sns";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

interface WebsocketResolversProps {
    readonly topic: sns.ITopic;
    readonly userPool: UserPool;
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly api: appsync.GraphqlApi;
}

/**
 * WebsocketResolvers - Manages AppSync resolvers for websocket communication
 *
 * This class sets up the following resolvers:
 *  - sendQuery: HTTP resolver for sending queries via SNS (direct HTTP call)
 *  - publishResponse: Resolver for publishing responses
 *  - receiveMessages: Subscription resolver for receiving messages
 */
export class WebsocketResolvers extends Construct {
    public readonly sendQueryResolver: appsync.Resolver;

    constructor(scope: Construct, id: string, props: WebsocketResolversProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        this.sendQueryResolver = this.create_send_query_resolver(prefix, props);

        const noneDataSource = props.api.addNoneDataSource("none", {
            name: "relay-source",
        });
        props.api.createResolver("publish-response-resolver", {
            typeName: "Mutation",
            fieldName: "publishResponse",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/publish-response-resolver.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
        props.api.createResolver("subscription-resolver", {
            typeName: "Subscription",
            fieldName: "receiveMessages",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/subscribe-resolver.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
    }

    /**
     * Creates an HTTP resolver for sendQuery mutation
     * Uses direct HTTP call to SNS API instead of Lambda for:
     * - Lower latency (no Lambda cold starts)
     * - Reduced cost (no Lambda invocations)
     * - Simpler architecture
     */
    private create_send_query_resolver(
        prefix: string,
        props: WebsocketResolversProps,
    ): appsync.Resolver {
        const api = props.api;
        const snsTopic = props.topic;

        // Add environment variable for the topic ARN (used by the JS resolver)
        api.addEnvironmentVariable("messagesTopicArn", snsTopic.topicArn);

        // Create HTTP data source for SNS
        const snsHttpDataSource = api.addHttpDataSource(
            "SnsHttpDataSource",
            `https://sns.${cdk.Aws.REGION}.amazonaws.com/`,
            {
                name: `${prefix}-snsHttpDataSource`,
                authorizationConfig: {
                    signingRegion: cdk.Aws.REGION,
                    signingServiceName: "sns",
                },
            },
        );
        snsTopic.grantPublish(snsHttpDataSource);

        // Create resolver using JavaScript HTTP resolver
        const resolver = snsHttpDataSource.createResolver("send-message-resolver", {
            typeName: "Mutation",
            fieldName: "sendQuery",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/send-query-http-resolver.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
        });

        NagSuppressions.addResourceSuppressions(
            snsHttpDataSource,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "IAM role implicitly created by CDK for HTTP data source.",
                },
            ],
            true,
        );

        return resolver;
    }
}
