/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of `Generative AI` backend construct.
    After the Direct WebSocket migration, this construct only contains
    the agent-tools-handler Lambda (for AI-rephrased tool descriptions).
    The invokeAgentCoreRuntime Lambda was removed — the browser now
    communicates directly with AgentCore containers via WebSocket.
*/
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";

import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { createLambda, generatePrefix } from "../shared/utils";

interface GenAIConstructProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly messagesTopic: sns.Topic;
    readonly agentToolsTopic: sns.Topic;
}

export class GenAIInterface extends Construct {
    constructor(scope: Construct, id: string, props: GenAIConstructProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        // Agent tools handler: receives tool invocation events from AgentCore containers
        // via the Agent Tools SNS Topic, calls Mistral to generate a human-friendly
        // description, and publishes the result to the Messages Topic for delivery
        // to the browser via AppSync (side-channel).
        const agentToolsHandler = createLambda(this, {
            name: `${prefix}-agent-tools-handler`,
            asset: "agent-tools-handler",
            handler: "index.handler",
            timeout: 1,
            memorySize: 256,
            shared: props.shared,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                MESSAGE_TOPIC_ARN: props.messagesTopic.topicArn,
            },
            dir: path.join(__dirname, "../../../src/genai-interface"),
        });
        props.messagesTopic.grantPublish(agentToolsHandler);
        agentToolsHandler.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources: [
                    `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`,
                    `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
                ],
            }),
        );

        // Subscribe Lambda to agent tools topic
        props.agentToolsTopic.addSubscription(
            new snsSubscriptions.LambdaSubscription(agentToolsHandler),
        );

        NagSuppressions.addResourceSuppressions(
            agentToolsHandler,
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
