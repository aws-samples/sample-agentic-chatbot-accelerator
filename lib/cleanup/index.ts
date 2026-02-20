// -------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -------------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import { CustomResource, Duration } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";
import { VectorKnowledgeBase } from "../knowledge-base";
import { Shared } from "../shared";
import { generatePrefix, getTagConditions } from "../shared/utils";

export interface CleanupProps {
    shared: Shared;
    kbInventoryTable?: dynamodb.Table;
    knowledgeBase?: VectorKnowledgeBase;
}

export class Cleanup extends Construct {
    public readonly customResource: CustomResource;

    constructor(scope: Construct, id: string, props: CleanupProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        // Extract CDK knowledge base ID to preserve during cleanup
        const cdkKnowledgeBaseIds = props.knowledgeBase
            ? props.knowledgeBase.knowledgeBase.knowledgeBaseId
            : "";

        // Extract CDK EventBridge rule name from the knowledge base construct
        const cdkRuleNamesStr = props.knowledgeBase?.s3DataSourceRule?.ruleName ?? "";

        // Lambda function that runs cleanup logic on stack deletion
        const tags = getTagConditions(this);
        const transformedTags = Object.fromEntries(
            Object.entries(tags).map(([key, value]) => [
                key.replace("aws:ResourceTag/", ""),
                value,
            ]),
        );

        const environmentVariables: Record<string, string> = {
            CDK_KNOWLEDGE_BASE_IDS: cdkKnowledgeBaseIds,
            CDK_RULE_NAMES: cdkRuleNamesStr,
            STACK_TAG: transformedTags.Stack || "_aca",
            ENVIRONMENT_TAG: transformedTags.Environment || "_tag",
        };

        if (props.kbInventoryTable) {
            environmentVariables.KB_INVENTORY_TABLE = props.kbInventoryTable.tableName;
        }

        const cleanupLambda = new lambda.Function(this, "CleanupLambda", {
            runtime: props.shared.pythonRuntime,
            functionName: `${prefix}-cleanCustomResources`,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "functions", "cleanup-handler")),
            timeout: Duration.minutes(15),
            environment: environmentVariables,
            layers: [props.shared.boto3Layer, props.shared.powerToolsLayer],
            tracing: lambda.Tracing.ACTIVE,
        });

        if (props.kbInventoryTable) {
            props.kbInventoryTable.grantReadData(cleanupLambda);
        }

        // Add permissions for Bedrock knowledge base cleanup
        // Restricted to resources tagged with "aca"
        cleanupLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock:DeleteKnowledgeBase",
                    "bedrock:DeleteDataSource",
                    "bedrock:GetKnowledgeBase",
                    "bedrock:ListDataSources",
                ],
                resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
                conditions: {
                    StringEquals: getTagConditions(this),
                },
            }),
        );

        cleanupLambda.role!.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName("BedrockAgentCoreFullAccess"),
        );

        // cleanupLambda.addToRolePolicy(
        //     new iam.PolicyStatement({
        //         effect: iam.Effect.ALLOW,
        //         actions: [
        //             "bedrock-agentcore:ListAgentRuntimes",
        //             "bedrock-agentcore:ListTagsForResource",
        //             "bedrock-agentcore:DeleteAgentRuntime",
        //             "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
        //         ],
        //         resources: [
        //             `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
        //         ],
        //         conditions: {
        //             StringEquals: getTagConditions(this),
        //         },
        //     }),
        // );

        // Add permissions for EventBridge rule cleanup
        // Restricted to resources tagged with "aca"
        cleanupLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "events:DeleteRule",
                    "events:RemoveTargets",
                    "events:ListTargetsByRule",
                    "events:DescribeRule",
                ],
                resources: [`arn:aws:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:rule/*`],
                conditions: {
                    StringEquals: getTagConditions(this),
                },
            }),
        );

        // Custom resource provider
        const provider = new Provider(this, "CleanupProvider", {
            onEventHandler: cleanupLambda,
        });

        // Custom resource that triggers the Lambda
        this.customResource = new CustomResource(this, "CleanupResource", {
            serviceToken: provider.serviceToken,
        });

        // Add dependencies to ensure cleanup runs before tables are deleted
        // This prevents race conditions during stack destruction
        if (props.kbInventoryTable) {
            this.customResource.node.addDependency(props.kbInventoryTable);
        }

        NagSuppressions.addResourceSuppressions(
            cleanupLambda,
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
        NagSuppressions.addResourceSuppressions(
            provider,
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

        const stack = cdk.Stack.of(this);
        NagSuppressions.addResourceSuppressionsByPath(
            stack,
            [`/${stack}/Cleanup/CleanupProvider/framework-onEvent/Resource`],
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "Lambda implicitly created by DynamoDBSeeder.",
                },
            ],
        );
    }
}
