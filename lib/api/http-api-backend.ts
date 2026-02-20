// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { parse } from "graphql";
import * as path from "path";

import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix, getTagConditions } from "../shared/utils";

export interface HttpApiBackendProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly userPool: cognito.UserPool;
    readonly sessionsTable: dynamodb.Table;
    readonly favoriteRuntimeTable: dynamodb.Table;
    readonly toolRegistryTable: dynamodb.Table;
    readonly mcpServerRegistryTable: dynamodb.Table;
    readonly byUserIdIndex: string;
    readonly api: appsync.GraphqlApi;
    readonly operationToExclude: string[];
}

export class HttpApiBackend extends Construct {
    readonly appSyncLambdaResolver: lambda.Function;

    constructor(scope: Construct, id: string, props: HttpApiBackendProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const tags = getTagConditions(this);
        const transformedTags = Object.fromEntries(
            Object.entries(tags).map(([key, value]) => [
                key.replace("aws:ResourceTag/", ""),
                value,
            ]),
        );

        const logGroup = new logs.LogGroup(this, "HttpApiResolverLogGroup", {
            logGroupName: `/aws/lambda/${prefix}-httpApiResolver`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Build environment variables, conditionally including KB-related values
        const environmentVariables: Record<string, string> = {
            ...props.shared.defaultEnvironmentVariables,
            SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
            SESSIONS_BY_USER_ID_INDEX_NAME: props.byUserIdIndex,
            TOOL_REGISTRY_TABLE: props.toolRegistryTable.tableName,
            MCP_SERVER_REGISTRY_TABLE: props.mcpServerRegistryTable.tableName,
            REGION_NAME: cdk.Aws.REGION,
        };

        const lambdaResolver = new lambda.Function(this, "HttpApiResolver", {
            functionName: `${prefix}-httpApiResolver`,
            code: props.shared.sharedCode.bundleWithLambdaAsset(
                path.join(__dirname, "./functions/http-api-handler"),
            ),
            handler: "index.handler",
            architecture: props.shared.lambdaArchitecture,
            layers: [props.shared.powerToolsLayer, props.shared.boto3Layer],
            logGroup: logGroup,
            memorySize: 512,
            environment: environmentVariables,
            runtime: props.shared.pythonRuntime,
            timeout: cdk.Duration.minutes(15),
            tracing: lambda.Tracing.ACTIVE,
        });

        props.sessionsTable.grantReadWriteData(lambdaResolver);
        props.favoriteRuntimeTable.grantReadWriteData(lambdaResolver);
        props.toolRegistryTable.grantReadData(lambdaResolver);
        props.mcpServerRegistryTable.grantReadData(lambdaResolver);

        const schema = parse(readFileSync("lib/api/schema/schema.graphql", "utf8"));

        const functionDataSource = props.api.addLambdaDataSource(
            "proxyResolverFunction",
            lambdaResolver,
        );

        function addResolvers(operationType: string) {
            /* eslint-disable  @typescript-eslint/no-explicit-any */
            const fieldNames = (
                schema.definitions
                    .filter((x) => x.kind == "ObjectTypeDefinition")
                    .filter((y: any) => y.name.value == operationType)[0] as any
            ).fields.map((z: any) => z.name.value);
            /* eslint-enable  @typescript-eslint/no-explicit-any */

            for (const fieldName of fieldNames) {
                // These resolvers are added by the Realtime API
                if (fieldName == "sendQuery" || fieldName == "publishResponse") {
                    continue;
                }
                // These resolvers are directly added to DynamoDB data source
                if (
                    fieldName == "updateFavoriteRuntime" ||
                    fieldName == "getFavoriteRuntime" ||
                    fieldName == "resetFavoriteRuntime"
                ) {
                    continue;
                }
                // These resolvers are handled by dedicated Lambda
                if (props.operationToExclude.includes(fieldName)) {
                    continue;
                }
                props.api.createResolver(`${fieldName}-resolver`, {
                    typeName: operationType,
                    fieldName: fieldName,
                    dataSource: functionDataSource,
                });
            }
        }

        addResolvers("Query");
        addResolvers("Mutation");

        const dynamoDataSource = props.api.addDynamoDbDataSource(
            "FavoriteCfgDataSource",
            props.favoriteRuntimeTable,
        );
        dynamoDataSource.createResolver("UpdateFavoriteRuntimeResolver", {
            typeName: "Mutation",
            fieldName: "updateFavoriteRuntime",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/favorite-runtime-resolvers/update.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
        });
        dynamoDataSource.createResolver("ResetFavoriteRuntimeResolver", {
            typeName: "Mutation",
            fieldName: "resetFavoriteRuntime",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/favorite-runtime-resolvers/delete.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
        });
        dynamoDataSource.createResolver("GetFavoriteRuntimeResolver", {
            typeName: "Query",
            fieldName: "getFavoriteRuntime",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/favorite-runtime-resolvers/get.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
        });

        this.appSyncLambdaResolver = lambdaResolver;

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
    }
}
