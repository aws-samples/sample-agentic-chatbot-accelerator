/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { LayerVersion, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { Shared } from "../shared";
import { Direction, SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

import { WebsocketResolvers } from "./websocket-resolvers";

interface WebsocketApiBackendProps {
    readonly shared: Shared;
    readonly userPool: UserPool;
    readonly api: appsync.GraphqlApi;
    readonly config: SystemConfig;
}

/**
 * WebsocketApiBackend class manages the backend infrastructure for websocket API communication.
 *
 * This class sets up:
 * - An SNS topic for message distribution
 * - An SQS queue with dead-letter queue for handling outgoing messages
 * - WebSocket resolvers for real-time communication
 * - Lambda function to handle outgoing messages and publish responses
 *
 * @property messagesTopic - SNS Topic for distributing chat messages
 * @property resolvers - WebSocket resolvers for real-time communication
 * @property queue - SQS Queue for handling outgoing messages
 */
export class WebsocketApiBackend extends Construct {
    public readonly messagesTopic: sns.Topic;
    public readonly resolvers: WebsocketResolvers;

    constructor(scope: Construct, id: string, props: WebsocketApiBackendProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const messagesTopic = new sns.Topic(this, "MessagesTopic", {
            topicName: `${prefix}-chatMessagesTopic`,
        });

        const resolvers = new WebsocketResolvers(this, "RealtimeResolvers", {
            topic: messagesTopic,
            userPool: props.userPool,
            shared: props.shared,
            api: props.api,
            config: props.config,
        });

        // Implements the block that publishResponse (GraphQL mutation) upon putting a message in the output Queue
        // The output queue contains the messages processed by the LLM.
        const powertoolsLayerJS = LayerVersion.fromLayerVersionArn(
            this,
            "PowertoolsLayerJS",
            `arn:aws:lambda:${
                cdk.Stack.of(this).region
            }:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:17`,
        );

        const outgoingMessageHandler = new NodejsFunction(this, "outgoing-message-handler", {
            entry: path.join(__dirname, "functions/outgoing-message-handler/index.ts"),
            layers: [powertoolsLayerJS],
            handler: "index.handler",
            runtime: Runtime.NODEJS_24_X,
            loggingFormat: LoggingFormat.JSON,
            environment: {
                GRAPHQL_ENDPOINT: props.api.graphqlUrl,
            },
        });
        props.api.grantMutation(outgoingMessageHandler);

        // Instead of SNS → SQS → Lambda
        messagesTopic.addSubscription(
            new subscriptions.LambdaSubscription(outgoingMessageHandler, {
                filterPolicyWithMessageBody: {
                    direction: sns.FilterOrPolicy.filter(
                        sns.SubscriptionFilter.stringFilter({
                            allowlist: [Direction.Out],
                        }),
                    ),
                },
            }),
        );

        this.resolvers = resolvers;
        this.messagesTopic = messagesTopic;

        /**
         * CDK NAG suppression
         */
        NagSuppressions.addResourceSuppressions(messagesTopic, [
            { id: "AwsSolutions-SNS2", reason: "No sensitive data in topic." },
            { id: "AwsSolutions-SNS3", reason: "No sensitive data in topic." },
        ]);

        NagSuppressions.addResourceSuppressions(
            outgoingMessageHandler,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "IAM role implicitly created by CDK.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "IAM role implicitly created by CDK.",
                },
            ],
            true,
        );
    }
}
