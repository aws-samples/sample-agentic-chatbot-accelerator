// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { VectorCollection } from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/opensearchserverless";

import { Construct } from "constructs";

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as oss from "aws-cdk-lib/aws-opensearchserverless";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";

import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";

import { generatePrefix, getTagConditions } from "../shared/utils";

const OPS_PROPS = [
    // Queries
    { type: "Query", field: "listKnowledgeBases" },
    { type: "Query", field: "listDataSources" },
    { type: "Query", field: "listDocuments" },
    { type: "Query", field: "getInputPrefix" },
    { type: "Query", field: "checkOnProcessStarted" },
    { type: "Query", field: "checkOnProcessCompleted" },
    { type: "Query", field: "checkOnDocumentsRemoved" },
    { type: "Query", field: "checkOnSyncInProgress" },
    { type: "Query", field: "getDocumentMetadata" },
    { type: "Query", field: "getPresignedUrl" },
    // Mutations
    { type: "Mutation", field: "deleteDocument" },
    { type: "Mutation", field: "createKnowledgeBase" },
    { type: "Mutation", field: "createDataSource" },
    { type: "Mutation", field: "deleteKnowledgeBase" },
    { type: "Mutation", field: "deleteDataSource" },
    { type: "Mutation", field: "syncKnowledgeBase" },
    { type: "Mutation", field: "updateMetadata" },
    { type: "Mutation", field: "batchUpdateMetadata" },
];

export interface KnowledgeBaseOpsProps {
    readonly api: appsync.GraphqlApi;
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly documentTable?: dynamodb.Table;
    readonly dataBucket?: s3.Bucket;
    readonly queueStartPipeline?: cdk.aws_sqs.Queue;
    readonly kbInventoryTable?: dynamodb.Table;
    readonly vectorCollection?: VectorCollection;
    readonly kbRole?: iam.IRole;
}

export class KnowledgeBaseOps extends Construct {
    readonly operations: string[];

    constructor(scope: Construct, id: string, props: KnowledgeBaseOpsProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const tags = getTagConditions(this);
        const transformedTags = Object.fromEntries(
            Object.entries(tags).map(([key, value]) => [
                key.replace("aws:ResourceTag/", ""),
                value,
            ]),
        );

        this.operations = [];

        if (
            props.documentTable &&
            props.dataBucket &&
            props.queueStartPipeline &&
            props.kbInventoryTable &&
            props.vectorCollection &&
            props.kbRole
        ) {
            const logGroup = new logs.LogGroup(this, "KnowledgeBaseResolverLogGroup", {
                logGroupName: `/aws/lambda/${prefix}-knowledgeBaseResolver`,
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            const lambdaResolver = new lambda.Function(this, "KnowledgeBaseResolver", {
                functionName: `${prefix}-knowledgeBaseResolver`,
                code: props.shared.sharedCode.bundleWithLambdaAsset(
                    path.join(__dirname, "./functions/knowledge-base-resolver"),
                ),
                handler: "index.handler",
                architecture: props.shared.lambdaArchitecture,
                layers: [props.shared.powerToolsLayer, props.shared.boto3Layer],
                logGroup: logGroup,
                memorySize: 128,
                environment: {
                    ...props.shared.defaultEnvironmentVariables,
                    DOCUMENT_TABLE_NAME: props.documentTable.tableName,
                    KB_INVENTORY_TABLE_NAME: props.kbInventoryTable.tableName,
                    KB_ROLE_ARN: props.kbRole.roleArn,
                    COLLECTION_ID: props.vectorCollection.collectionId,
                    DATA_BUCKET_ARN: props.dataBucket.bucketArn,
                    START_PIPELINE_QUEUE_ARN: props.queueStartPipeline.queueArn,
                    STACK_NAME: transformedTags.Stack || "aca",
                    ENV_PREFIX: transformedTags.Environment || "_tag",
                    REGION_NAME: cdk.Aws.REGION,
                },
                runtime: props.shared.pythonRuntime,
                timeout: cdk.Duration.minutes(15),
                tracing: lambda.Tracing.ACTIVE,
            });

            // Permissions
            lambdaResolver.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: ["aoss:APIAccessAll"],
                    resources: [props.vectorCollection.collectionArn],
                }),
            );
            lambdaResolver.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: ["iam:PassRole"],
                    resources: [props.kbRole.roleArn],
                }),
            );

            new oss.CfnAccessPolicy(this, "ManageIndexPolicyFromLambda", {
                name: `${prefix}-pol-from-lambda`.substring(0, 32),
                type: "data",
                policy: JSON.stringify([
                    {
                        Rules: [
                            {
                                Resource: [`index/${props.vectorCollection.collectionName}/*`],
                                Permission: [
                                    "aoss:DescribeIndex",
                                    "aoss:CreateIndex",
                                    "aoss:DeleteIndex",
                                ],
                                ResourceType: "index",
                            },
                            {
                                Resource: [`collection/${props.vectorCollection.collectionName}`],
                                Permission: ["aoss:DescribeCollectionItems"],
                                ResourceType: "collection",
                            },
                        ],
                        Principal: [lambdaResolver.role!.roleArn],
                        Description: "Accessing from Lambda function",
                    },
                ]),
            });

            lambdaResolver.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: [
                        "events:PutRule",
                        "events:PutTargets",
                        "events:DeleteRule",
                        "events:ListTargetsByRule",
                        "events:RemoveTargets",
                        "events:TagResource",
                    ],
                    resources: [
                        `arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:rule/*`,
                    ],
                }),
            );

            props.dataBucket.grantReadWrite(lambdaResolver);
            props.documentTable.grantReadWriteData(lambdaResolver);
            props.kbInventoryTable.grantReadWriteData(lambdaResolver);

            lambdaResolver.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: [
                        "bedrock:ListKnowledgeBases",
                        "bedrock:ListTagsForResource",
                        "bedrock:ListDataSources",
                        "bedrock:ListIngestionJobs",
                        "bedrock:GetDataSource",
                        "bedrock:CreateKnowledgeBase",
                        "bedrock:GetKnowledgeBase",
                        "bedrock:DeleteKnowledgeBase",
                        "bedrock:TagResource",
                        "bedrock:CreateDataSource",
                        "bedrock:DeleteDataSource",
                        "bedrock:StartIngestionJob",
                    ],
                    resources: [
                        `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
                    ],
                }),
            );

            // resolver definition
            const functionDataSource = props.api.addLambdaDataSource(
                "KnowledgeBaseOpsLambdaDataSource",
                lambdaResolver,
                {
                    name: `${prefix}-knowledgeBaseOpsLambdaDataSource`,
                },
            );

            OPS_PROPS.forEach((op) => {
                this.operations.push(op.field);
                props.api.createResolver(`${op.field}-resolver`, {
                    typeName: op.type,
                    fieldName: op.field,
                    dataSource: functionDataSource,
                });
            });
            [lambdaResolver, functionDataSource].forEach((element) => {
                NagSuppressions.addResourceSuppressions(
                    element,
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
        } else {
            OPS_PROPS.forEach((op) => this.operations.push(op.field));
        }
    }
}
