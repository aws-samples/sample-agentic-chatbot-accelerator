/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of `Generative AI` backend construct
*/
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";

import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { createLambda, generatePrefix, getTagConditions } from "../shared/utils";

interface GenAIConstructProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly sessionsTable: dynamodb.Table;
    readonly byUserIdIndex: string;
    readonly messagesTopic: sns.Topic;
    readonly agentToolsTopic: sns.Topic;
}

export class GenAIInterface extends Construct {
    public readonly invokeAgentCoreRuntime: lambda.Function;

    constructor(scope: Construct, id: string, props: GenAIConstructProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const invokeAgentCoreRuntime = createLambda(this, {
            name: `${prefix}-invoke-agentCoreRuntime`,
            asset: "agent-core",
            handler: "index.handler",
            timeout: props.config.ingestionLambdaProps.timeoutInMinutes,
            memorySize: 512,
            shared: props.shared,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
                SESSIONS_BY_USER_ID_INDEX_NAME: props.byUserIdIndex,
                MESSAGE_TOPIC_ARN: props.messagesTopic.topicArn,
                ACCOUNT_ID: cdk.Stack.of(this).account,
            },
            dir: __dirname,
            reservedConcurrentExecutions: props.config.ingestionLambdaProps.reservedConcurrency,
        });

        props.sessionsTable.grantReadWriteData(invokeAgentCoreRuntime);
        props.messagesTopic.grantPublish(invokeAgentCoreRuntime);
        invokeAgentCoreRuntime.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    "bedrock-agentcore:InvokeAgentRuntime",
                    "bedrock-agentcore:InvokeAgentRuntimeForUser",
                    "bedrock-agentcore:GetAgentRuntimeEndpoint",
                ],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
                ],
                conditions: {
                    StringEquals: getTagConditions(this),
                },
            }),
        );

        // Create Lambda to handle agent tools messages
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
            dir: __dirname,
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

        //
        [invokeAgentCoreRuntime, agentToolsHandler].forEach((func) => {
            NagSuppressions.addResourceSuppressions(
                func,
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
        });

        this.invokeAgentCoreRuntime = invokeAgentCoreRuntime;
    } // end of constructor
}
