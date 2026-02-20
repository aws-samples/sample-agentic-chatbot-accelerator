// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import * as path from "path";

import { VectorCollection } from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/opensearchserverless";
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";
import { AgentCoreApis } from "./agent-core-runtime";
import { HttpApiBackend } from "./http-api-backend";
import { KnowledgeBaseOps } from "./knowledge-base";
import { ChatbotDynamoDBTables } from "./tables";
import { WebsocketApiBackend } from "./websocket-api-backend";

export interface ChatbotApiProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly userPool: cognito.UserPool;
    // AgentCore Related
    readonly agentCoreContainer: DockerImageAsset;
    readonly agentCoreRuntimeTable: dynamodb.Table;
    readonly toolRegistryTable: dynamodb.Table;
    readonly mcpServerRegistryTable: dynamodb.Table;
    readonly agentCoreSummaryTable: dynamodb.Table;
    readonly agentCoreExecutionRole: iam.Role;
    readonly agentToolsTopic: sns.Topic;
    // optional props for document processing
    readonly dataBucket?: s3.Bucket;
    readonly documentTable?: dynamodb.Table;
    readonly queueStartPipeline?: cdk.aws_sqs.Queue;
    // optional props for Knowledge Bases
    readonly kbInventoryTable?: dynamodb.Table;
    readonly vectorCollection?: VectorCollection;
    readonly kbRole?: iam.IRole;
}

/**
 * ChatbotApi class represents the API infrastructure for a chatbot application.
 *
 * This class sets up:
 * - AppSync GraphQL API with Cognito User Pool and IAM authorization
 * - DynamoDB tables for chat data storage
 * - HTTP API backend for synchronous operations
 * - WebSocket API backend for real-time messaging
 * - SNS topic for message distribution
 * - SQS queue for outbound messages
 * - CloudWatch logging configuration
 */
export class ChatbotApi extends Construct {
    public readonly messagesTopic: sns.Topic;
    public readonly sessionsTable: dynamodb.Table;
    public readonly agentsTable: dynamodb.Table;
    public readonly byUserIndex: string;
    public readonly graphqlApi: appsync.GraphqlApi;

    constructor(scope: Construct, id: string, props: ChatbotApiProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const loggingRole = new iam.Role(this, "apiLoggingRole", {
            assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
            inlinePolicies: {
                loggingPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ["logs:*"],
                            resources: ["*"],
                        }),
                    ],
                }),
            },
        });

        const chatTables = new ChatbotDynamoDBTables(this, "ChatTables");

        const api = new appsync.GraphqlApi(this, "ChatbotApi", {
            name: `${prefix}-api`,
            definition: appsync.Definition.fromFile(path.join(__dirname, "schema/schema.graphql")),
            authorizationConfig: {
                defaultAuthorization: {
                    authorizationType: appsync.AuthorizationType.USER_POOL,
                    userPoolConfig: {
                        userPool: props.userPool,
                    },
                },
                additionalAuthorizationModes: [
                    {
                        authorizationType: appsync.AuthorizationType.IAM,
                    },
                ],
            },
            logConfig: {
                fieldLogLevel: appsync.FieldLogLevel.ALL,
                retention: RetentionDays.ONE_MONTH,
                role: loggingRole,
            },
            xrayEnabled: true,
            visibility: appsync.Visibility.GLOBAL, // TODO: update this if Private hosting is enable
        });

        const realtimeBackend = new WebsocketApiBackend(this, "RealtimeBackend", {
            ...props,
            api: api,
        });

        const agentCoreApis = new AgentCoreApis(this, "AgentCoreBackend", {
            ...props,
            api: api,
        });

        const kbApis = new KnowledgeBaseOps(this, "KnowledgeBaseOps", {
            ...props,
            api: api,
        });

        new HttpApiBackend(this, "SyncApiBackend", {
            ...props,
            api: api,
            sessionsTable: chatTables.sessionsTable,
            favoriteRuntimeTable: chatTables.favoriteRuntimeTable,
            byUserIdIndex: chatTables.byUserIdIndex,
            operationToExclude: [...agentCoreApis.operations, ...kbApis.operations],
        });

        // CDK outputs
        new cdk.CfnOutput(this, "GraphQLApiUrl", { value: api.graphqlUrl });
        new cdk.CfnOutput(this, "GraphQLApiId", { value: api.apiId || "" });

        this.messagesTopic = realtimeBackend.messagesTopic;
        this.graphqlApi = api;
        this.sessionsTable = chatTables.sessionsTable;
        this.byUserIndex = chatTables.byUserIdIndex;

        // CDK NAG Suppression
        NagSuppressions.addResourceSuppressions(loggingRole, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Access to all log groups required for CloudWatch log group creation.",
            },
        ]);
    }
}
