// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";

import { LayerVersion, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";

import { createLambda, generatePrefix, getTagConditions } from "../shared/utils";

export interface AgentCoreApisProps {
    readonly api: appsync.GraphqlApi;
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly agentCoreContainer: DockerImageAsset;
    readonly agentCoreRuntimeTable: dynamodb.Table;
    readonly agentCoreSummaryTable: dynamodb.Table;
    readonly toolRegistryTable: dynamodb.Table;
    readonly mcpServerRegistryTable: dynamodb.Table;
    readonly agentCoreExecutionRole: iam.Role;
    readonly agentToolsTopic: sns.Topic;
}

export class AgentCoreApis extends Construct {
    readonly operations: string[];

    constructor(scope: Construct, id: string, props: AgentCoreApisProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        this.operations = [];

        // Lambda resolver for AgentCore Runtime Endpoint creation
        const tags = getTagConditions(this);
        const transformedTags = Object.fromEntries(
            Object.entries(tags).map(([key, value]) => [
                key.replace("aws:ResourceTag/", ""),
                value,
            ]),
        );
        const logGroup = new logs.LogGroup(this, "AgentCoreResolverLogGroup", {
            logGroupName: `/aws/lambda/${prefix}-agentCoreResolver`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const agentCoreRuntimeCreationResolver = new lambda.Function(this, "AgentCoreResolver", {
            functionName: `${prefix}-agentCoreResolver`,
            code: props.shared.sharedCode.bundleWithLambdaAsset(
                path.join(__dirname, "./functions/agent-factory-resolver"),
            ),
            handler: "index.handler",
            architecture: props.shared.lambdaArchitecture,
            layers: [props.shared.powerToolsLayer, props.shared.boto3Layer],
            logGroup: logGroup,
            memorySize: 128,
            environment: {
                ...props.shared.defaultEnvironmentVariables,
                CONTAINER_URI: props.agentCoreContainer.imageUri,
                AGENT_CORE_RUNTIME_ROLE_ARN: props.agentCoreExecutionRole.roleArn,
                AGENT_CORE_RUNTIME_TABLE: props.agentCoreRuntimeTable.tableName,
                AGENT_CORE_SUMMARY_TABLE: props.agentCoreSummaryTable.tableName,
                TOOL_REGISTRY_TABLE: props.toolRegistryTable.tableName,
                MCP_SERVER_REGISTRY_TABLE: props.mcpServerRegistryTable.tableName,
                ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
                STACK_TAG: transformedTags.Stack || "aca",
                ENVIRONMENT_TAG: transformedTags.Environment || "",
            },
            runtime: props.shared.pythonRuntime,
            timeout: cdk.Duration.minutes(3),
            tracing: lambda.Tracing.ACTIVE,
        });
        // Permissions
        props.agentCoreRuntimeTable.grantReadWriteData(agentCoreRuntimeCreationResolver);
        props.agentCoreSummaryTable.grantReadWriteData(agentCoreRuntimeCreationResolver);

        // TODO - consider using a custom policy with minimal permissions
        agentCoreRuntimeCreationResolver.role!.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName("BedrockAgentCoreFullAccess"),
        );
        // Add BedrockAgentCore PassRole permission
        agentCoreRuntimeCreationResolver.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "BedrockAgentCorePassRoleAccess",
                effect: iam.Effect.ALLOW,
                actions: ["iam:PassRole"],
                resources: [props.agentCoreExecutionRole.roleArn],
                conditions: {
                    StringEquals: {
                        "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
                    },
                },
            }),
        );

        const functionAgentCoreDataSource = props.api.addLambdaDataSource(
            "CreateAgentCoreRuntimeDataSource",
            agentCoreRuntimeCreationResolver,
            {
                name: `${prefix}-createAgentCoreRuntimeDataSource`,
            },
        );

        // associate resolver to operations
        [
            {
                type: "Mutation",
                field: "createAgentCoreRuntime",
            },
            {
                type: "Query",
                field: "listRuntimeAgents",
            },
            {
                type: "Query",
                field: "getRuntimeConfigurationByVersion",
            },
            {
                type: "Query",
                field: "getRuntimeConfigurationByQualifier",
            },
            {
                type: "Query",
                field: "getDefaultRuntimeConfiguration",
            },
            {
                type: "Mutation",
                field: "tagAgentCoreRuntime",
            },
            {
                type: "Query",
                field: "listAgentVersions",
            },
            {
                type: "Query",
                field: "listAgentEndpoints",
            },
            {
                type: "Mutation",
                field: "deleteAgentRuntime",
            },
            {
                type: "Mutation",
                field: "deleteAgentRuntimeEndpoints",
            },
        ].forEach((op) => {
            this.operations.push(op.field);
            props.api.createResolver(`${op.field}-resolver`, {
                typeName: op.type,
                fieldName: op.field,
                dataSource: functionAgentCoreDataSource,
            });
        });

        // Subscription/Mutation for Agent Runtime Status Update Notification
        const noneDataSource = props.api.addNoneDataSource("agentFactory-none-ds", {
            name: "agentFactory-relay-source",
        });
        props.api.createResolver("publish-runtime-update-resolver", {
            typeName: "Mutation",
            fieldName: "publishRuntimeUpdate",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/runtime-update/publish.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
        props.api.createResolver("subscription-runtime-update-resolver", {
            typeName: "Subscription",
            fieldName: "receiveUpdateNotification",
            code: appsync.Code.fromAsset(
                path.join(__dirname, "functions/resolvers/runtime-update/subscribe.js"),
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });
        [
            {
                type: "Mutation",
                field: "publishRuntimeUpdate",
            },
            {
                type: "Subscription",
                field: "receiveUpdateNotification",
            },
        ].forEach((op) => {
            this.operations.push(op.field);
        });

        // stepFunction to handle endpoint deletion

        const deleteEndpointFunc = createLambda(this, {
            name: `${prefix}-startRuntimeEndpointDeletion`,
            asset: "delete-agent-runtime-endpoint",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        deleteEndpointFunc.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:DeleteAgentRuntimeEndpoint"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const checkOnDeleteEndpoint = createLambda(this, {
            name: `${prefix}-checkOnRuntimeEndpointDeletion`,
            asset: "check-on-delete-endpoint",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        checkOnDeleteEndpoint.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:GetAgentRuntimeEndpoint"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const powertoolsLayerJS = LayerVersion.fromLayerVersionArn(
            this,
            "PowertoolsLayerJS",
            `arn:aws:lambda:${
                cdk.Stack.of(this).region
            }:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:17`,
        );
        const notifyRuntimeUpdate = new NodejsFunction(this, "notify-runtime-update", {
            entry: path.join(__dirname, "functions/notify-runtime-update/index.ts"),
            layers: [powertoolsLayerJS],
            handler: "index.handler",
            runtime: Runtime.NODEJS_24_X,
            loggingFormat: LoggingFormat.JSON,
            environment: {
                GRAPHQL_ENDPOINT: props.api.graphqlUrl,
            },
        });
        props.api.grantMutation(notifyRuntimeUpdate, "publishRuntimeUpdate");

        const processingStateMachineLogGroup = new logs.LogGroup(
            scope,
            "AgentFactoryStepFunctionsLogGroup",
            {
                logGroupName: `/aws/${prefix}/states/agentFactory/logs`,
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            },
        );
        const substitutions = {
            startRuntimeEndpointDeletionFunctionArn: deleteEndpointFunc.functionArn,
            checkOnEndpointDeleteFunctionArn: checkOnDeleteEndpoint.functionArn,
            summaryTableArn: props.agentCoreSummaryTable.tableArn,
            notifyRuntimeUpdateFunctionArn: notifyRuntimeUpdate.functionArn,
        };

        const stateMachine = new sfn.StateMachine(scope, "DeleteAgentCoreEndpointStateMachine", {
            definitionBody: sfn.DefinitionBody.fromFile(
                path.join(__dirname, `./state-machines/delete-agentcore-endpoints.json`),
            ),
            definitionSubstitutions: substitutions,
            stateMachineName: `${prefix}-deleteAgentCoreEndpoint`,
            logs: {
                destination: processingStateMachineLogGroup,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        deleteEndpointFunc.grantInvoke(stateMachine);
        checkOnDeleteEndpoint.grantInvoke(stateMachine);
        notifyRuntimeUpdate.grantInvoke(stateMachine);
        props.agentCoreSummaryTable.grantReadWriteData(stateMachine);

        // associate step function to resolver
        stateMachine.grantStartExecution(agentCoreRuntimeCreationResolver);
        agentCoreRuntimeCreationResolver.addEnvironment(
            "DELETE_ENDPOINTS_STATE_MACHINE_ARN",
            stateMachine.stateMachineArn,
        );

        // stepFunction to handle runtime deletion
        const listEndpointsFunc = createLambda(this, {
            name: `${prefix}-listRuntimeEndpoints`,
            asset: "list-agent-runtime-endpoints",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        listEndpointsFunc.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:ListAgentRuntimeEndpoints"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const startDeleteRuntime = createLambda(this, {
            name: `${prefix}-startDeleteRuntime`,
            asset: "delete-agent-runtime",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        startDeleteRuntime.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:DeleteAgentRuntime"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const checkOnDeleteRuntime = createLambda(this, {
            name: `${prefix}-checkOnDeleteRuntime`,
            asset: "check-on-delete-runtime",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        checkOnDeleteRuntime.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:GetAgentRuntime"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const checkOnExistingMemory = createLambda(this, {
            name: `${prefix}-checkOnExistMemory`,
            asset: "check-on-exist-memory",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                ENVIRONMENT_TAG: transformedTags.Environment,
                STACK_TAG: transformedTags.Stack,
            },
        });
        checkOnExistingMemory.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock-agentcore:ListMemories",
                    "bedrock-agentcore:GetMemory",
                    "bedrock-agentcore:ListTagsForResource",
                ],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`,
                ],
            }),
        );

        const startDeleteMemory = createLambda(this, {
            name: `${prefix}-startDeleteMemory`,
            asset: "delete-memory",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        startDeleteMemory.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:DeleteMemory"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`,
                ],
            }),
        );

        const checkOnDeleteMemory = createLambda(this, {
            name: `${prefix}-checkOnDeleteMemory`,
            asset: "check-on-delete-memory",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        checkOnDeleteMemory.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:GetMemory"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`,
                ],
            }),
        );

        const removeRuntimeVersions = createLambda(this, {
            name: `${prefix}-removeRuntimeReferences`,
            asset: "delete-agent-runtime-references",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                VERSIONS_TABLE_NAME: props.agentCoreRuntimeTable.tableName,
            },
        });
        props.agentCoreRuntimeTable.grantReadWriteData(removeRuntimeVersions);

        const substitutionsDeleteRuntime = {
            listRuntimeEndpointFunctionArn: listEndpointsFunc.functionArn,
            startRuntimeEndpointDeletionFunctionArn: deleteEndpointFunc.functionArn,
            checkOnEndpointDeleteFunctionArn: checkOnDeleteEndpoint.functionArn,
            startDeleteRuntimeFunctionArn: startDeleteRuntime.functionArn,
            checkOnDeleteRuntimeFunctionArn: checkOnDeleteRuntime.functionArn,
            summaryTableArn: props.agentCoreSummaryTable.tableArn,
            notifyRuntimeUpdateFunctionArn: notifyRuntimeUpdate.functionArn,
            checkOnExistingMemoryFunctionArn: checkOnExistingMemory.functionArn,
            startDeleteMemoryFunctionArn: startDeleteMemory.functionArn,
            checkOnDeleteMemoryFunctionArn: checkOnDeleteMemory.functionArn,
            removeRuntimeVersionsFunctionArn: removeRuntimeVersions.functionArn,
        };

        const stateMachineDeleteRuntime = new sfn.StateMachine(scope, "DeleteRuntimeStateMachine", {
            definitionBody: sfn.DefinitionBody.fromFile(
                path.join(__dirname, `./state-machines/delete-agentcore-runtime.json`),
            ),
            definitionSubstitutions: substitutionsDeleteRuntime,
            stateMachineName: `${prefix}-deleteAgentCoreRuntime`,
            logs: {
                destination: processingStateMachineLogGroup,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        listEndpointsFunc.grantInvoke(stateMachineDeleteRuntime);
        deleteEndpointFunc.grantInvoke(stateMachineDeleteRuntime);
        checkOnDeleteEndpoint.grantInvoke(stateMachineDeleteRuntime);
        startDeleteRuntime.grantInvoke(stateMachineDeleteRuntime);
        checkOnDeleteRuntime.grantInvoke(stateMachineDeleteRuntime);
        notifyRuntimeUpdate.grantInvoke(stateMachineDeleteRuntime);
        checkOnExistingMemory.grantInvoke(stateMachineDeleteRuntime);
        startDeleteMemory.grantInvoke(stateMachineDeleteRuntime);
        checkOnDeleteMemory.grantInvoke(stateMachineDeleteRuntime);
        removeRuntimeVersions.grantInvoke(stateMachineDeleteRuntime);
        props.agentCoreSummaryTable.grantReadWriteData(stateMachineDeleteRuntime);

        stateMachineDeleteRuntime.grantStartExecution(agentCoreRuntimeCreationResolver);
        agentCoreRuntimeCreationResolver.addEnvironment(
            "DELETE_RUNTIME_STATE_MACHINE_ARN",
            stateMachineDeleteRuntime.stateMachineArn,
        );

        // stepFunction to handle runtime creation/update
        const startMemoryCreationFunc = createLambda(this, {
            name: `${prefix}-startMemoryCreation`,
            asset: "create-memory",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                ENVIRONMENT_TAG: transformedTags.Environment,
                STACK_TAG: transformedTags.Stack,
            },
        });
        startMemoryCreationFunc.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:CreateMemory", "bedrock-agentcore:TagResource"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`,
                ],
            }),
        );

        const checkOnCreateMemoryFunc = createLambda(this, {
            name: `${prefix}-checkOnCreateMemory`,
            asset: "check-on-create-memory",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        checkOnCreateMemoryFunc.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:GetMemory"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`,
                ],
            }),
        );

        const startRuntimeCreationFunc = createLambda(this, {
            name: `${prefix}-startRuntimeCreation`,
            asset: "create-runtime-version",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                CONTAINER_URI: props.agentCoreContainer.imageUri,
                AGENT_CORE_RUNTIME_ROLE_ARN: props.agentCoreExecutionRole.roleArn,
                AGENT_CORE_RUNTIME_TABLE: props.agentCoreRuntimeTable.tableName,
                TOOL_REGISTRY_TABLE: props.toolRegistryTable.tableName,
                MCP_SERVER_REGISTRY_TABLE: props.mcpServerRegistryTable.tableName,
                ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
                ENVIRONMENT_TAG: transformedTags.Environment,
                STACK_TAG: transformedTags.Stack,
                AGENT_TOOLS_TOPIC_ARN: props.agentToolsTopic.topicArn,
            },
        });
        // TODO - consider using a custom policy with minimal permissions
        // startRuntimeCreationFunc.addToRolePolicy(
        //     new iam.PolicyStatement({
        //         effect: iam.Effect.ALLOW,
        //         actions: [
        //             "bedrock-agentcore:ListAgentRuntimes",
        //             "bedrock-agentcore:ListTagsForResource",
        //             "bedrock-agentcore:UpdateAgentRuntime",
        //             "bedrock-agentcore:CreateAgentRuntime",
        //             "bedrock-agentcore:TagResource",
        //         ],
        //         resources: [
        //             `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
        //         ],
        //     }),
        // );
        startRuntimeCreationFunc.role!.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName("BedrockAgentCoreFullAccess"),
        );
        startRuntimeCreationFunc.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "BedrockAgentCorePassRoleAccess",
                effect: iam.Effect.ALLOW,
                actions: ["iam:PassRole"],
                resources: [props.agentCoreExecutionRole.roleArn],
                conditions: {
                    StringEquals: {
                        "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
                    },
                },
            }),
        );

        const checkOnRuntimeCreationFunc = createLambda(this, {
            name: `${prefix}-checkOnRuntimeCreation`,
            asset: "check-on-create-runtime",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        checkOnRuntimeCreationFunc.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock-agentcore:GetAgentRuntime"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:runtime/*`,
                ],
            }),
        );

        const substitutionsCreateRuntime = {
            startMemoryCreationFuncArn: startMemoryCreationFunc.functionArn,
            checkOnExistingMemoryFunctionArn: checkOnExistingMemory.functionArn,
            checkOnCreateMemoryFuncArn: checkOnCreateMemoryFunc.functionArn,
            startRuntimeCreationFuncArn: startRuntimeCreationFunc.functionArn,
            checkOnRuntimeCreationFunc: checkOnRuntimeCreationFunc.functionArn,
            notifyRuntimeUpdateFunctionArn: notifyRuntimeUpdate.functionArn,
            summaryTableArn: props.agentCoreSummaryTable.tableArn,
            agentVersionTableArn: props.agentCoreRuntimeTable.tableArn,
        };

        const stateMachineCreateRuntime = new sfn.StateMachine(scope, "CreateRuntimeStateMachine", {
            definitionBody: sfn.DefinitionBody.fromFile(
                path.join(__dirname, `./state-machines/create-agentcore-runtime.json`),
            ),
            definitionSubstitutions: substitutionsCreateRuntime,
            stateMachineName: `${prefix}-createAgentCoreRuntime`,
            logs: {
                destination: processingStateMachineLogGroup,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });
        startMemoryCreationFunc.grantInvoke(stateMachineCreateRuntime);
        checkOnExistingMemory.grantInvoke(stateMachineCreateRuntime);
        checkOnCreateMemoryFunc.grantInvoke(stateMachineCreateRuntime);
        startRuntimeCreationFunc.grantInvoke(stateMachineCreateRuntime);
        checkOnRuntimeCreationFunc.grantInvoke(stateMachineCreateRuntime);
        notifyRuntimeUpdate.grantInvoke(stateMachineCreateRuntime);
        props.agentCoreSummaryTable.grantReadWriteData(stateMachineCreateRuntime);
        props.agentCoreRuntimeTable.grantWriteData(stateMachineCreateRuntime);

        stateMachineCreateRuntime.grantStartExecution(agentCoreRuntimeCreationResolver);
        agentCoreRuntimeCreationResolver.addEnvironment(
            "CREATE_RUNTIME_STATE_MACHINE_ARN",
            stateMachineCreateRuntime.stateMachineArn,
        );

        // CDK NAG
        [
            agentCoreRuntimeCreationResolver,
            functionAgentCoreDataSource,
            deleteEndpointFunc,
            checkOnDeleteEndpoint,
            notifyRuntimeUpdate,
            stateMachine,
            listEndpointsFunc,
            startDeleteRuntime,
            checkOnDeleteRuntime,
            checkOnExistingMemory,
            startDeleteMemory,
            checkOnDeleteMemory,
            removeRuntimeVersions,
            stateMachineDeleteRuntime,
            startMemoryCreationFunc,
            checkOnCreateMemoryFunc,
            startRuntimeCreationFunc,
            checkOnRuntimeCreationFunc,
            stateMachineCreateRuntime,
        ].forEach((element) => {
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
