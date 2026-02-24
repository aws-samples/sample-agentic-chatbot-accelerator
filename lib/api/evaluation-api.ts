// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";

import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

export interface EvaluationApiProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly api: appsync.GraphqlApi;
    readonly evaluatorsTable: dynamodb.Table;
    readonly byUserIdIndex: string;
}

/**
 * EvaluationApi class sets up the evaluation infrastructure with SQS-based architecture
 *
 * Architecture:
 * AppSync → EvaluationResolver → SQS Queue → EvaluationExecutor → DynamoDB/S3
 *
 * Creates:
 * - S3 bucket for evaluation data storage
 * - SQS queue for test case processing (with DLQ)
 * - EvaluationResolver Lambda for CRUD operations and queue submission
 * - EvaluationExecutor Lambda for processing individual test cases
 * - AppSync resolvers for GraphQL operations
 * - Required IAM permissions
 */
export class EvaluationApi extends Construct {
    public readonly operations: string[];
    public readonly evaluationResolver: lambda.Function;
    public readonly evaluationExecutor: lambda.Function;
    public readonly evaluationsBucket: s3.Bucket;
    public readonly evaluationQueue: sqs.Queue;

    constructor(scope: Construct, id: string, props: EvaluationApiProps) {
        super(scope, id);

        const prefix = generatePrefix(this);
        const stack = cdk.Stack.of(this);

        // Determine removal policy based on environment prefix
        const removalCondition = ["prod-", "prd-", "live-"].some((p) =>
            prefix.toLowerCase().startsWith(p.toLowerCase()),
        )
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY;
        const autoDeleteObjects = removalCondition === cdk.RemovalPolicy.DESTROY;

        const loggingBucket = new s3.Bucket(this, "EvaluationsLoggingBucket", {
            bucketName: `${prefix}-logging-evaluations-${stack.region}-${stack.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
        });

        // Create S3 bucket for evaluation data
        const evaluationsBucket = new s3.Bucket(this, "EvaluationsBucket", {
            bucketName: `${prefix}-evaluations-${stack.region}-${stack.account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
            enforceSSL: true,
            serverAccessLogsBucket: loggingBucket,
            serverAccessLogsPrefix: `/aws/${prefix}/evaluations-bucket/logs`,
        });

        // Create Dead Letter Queue for failed test cases
        const evaluationDLQ = new sqs.Queue(this, "EvaluationDLQ", {
            queueName: `${prefix}-evaluation-dlq`,
            retentionPeriod: Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
        });

        // Create SQS Queue for test case processing
        // Each message represents a single test case to be evaluated
        const evaluationQueue = new sqs.Queue(this, "EvaluationQueue", {
            queueName: `${prefix}-evaluation-queue`,
            visibilityTimeout: Duration.minutes(15), // Match Lambda timeout
            retentionPeriod: Duration.days(14),
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: {
                queue: evaluationDLQ,
                maxReceiveCount: 3,
            },
        });

        // Operations handled by this construct
        this.operations = [
            "listEvaluators",
            "getEvaluator",
            "createEvaluator",
            "deleteEvaluator",
            "runEvaluation",
        ];

        // Create CloudWatch log group for the EvaluationResolver
        const resolverLogGroup = new logs.LogGroup(this, "EvaluationResolverLogGroup", {
            logGroupName: `/aws/lambda/${prefix}-evaluation-resolver`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Create the evaluation resolver Lambda
        // Handles CRUD operations and submits test cases to SQS queue
        const evaluationResolver = new lambda.Function(this, "EvaluationResolver", {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "functions/evaluation-resolver")),
            timeout: Duration.seconds(30),
            memorySize: 512,
            logGroup: resolverLogGroup,
            environment: {
                EVALUATIONS_TABLE: props.evaluatorsTable.tableName,
                EVALUATIONS_BUCKET: evaluationsBucket.bucketName,
                EVALUATION_QUEUE_URL: evaluationQueue.queueUrl,
                BY_USER_ID_INDEX: props.byUserIdIndex,
                ACCOUNT_ID: stack.account,
            },
            layers: props.shared.powerToolsLayer ? [props.shared.powerToolsLayer] : [],
        });

        // Create CloudWatch log group for the EvaluationExecutor
        const executorLogGroup = new logs.LogGroup(this, "EvaluationExecutorLogGroup", {
            logGroupName: `/aws/lambda/${prefix}-evaluation-executor`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Create the evaluation executor Lambda
        // Processes individual test cases from SQS queue
        // Note: strands-agents-evals is too large for a Lambda layer, so we bundle it directly
        const evaluationExecutor = new lambda.Function(this, "EvaluationExecutor", {
            functionName: `${prefix}-evaluation-executor`,
            code: lambda.Code.fromAsset(path.join(__dirname, "functions/evaluation-executor"), {
                bundling: {
                    image: props.shared.pythonRuntime.bundlingImage,
                    platform: props.shared.lambdaArchitecture.dockerPlatform,
                    command: [
                        "bash",
                        "-c",
                        "pip install strands-agents-evals -t /asset-output && cp -au . /asset-output",
                    ],
                },
            }),
            handler: "index.handler",
            architecture: props.shared.lambdaArchitecture,
            layers: [props.shared.powerToolsLayer],
            logGroup: executorLogGroup,
            memorySize: 2048,
            environment: {
                ...props.shared.defaultEnvironmentVariables,
                EVALUATIONS_TABLE: props.evaluatorsTable.tableName,
                EVALUATIONS_BUCKET: evaluationsBucket.bucketName,
                ACCOUNT_ID: stack.account,
                APPSYNC_API_ENDPOINT: props.api.graphqlUrl,
            },
            runtime: props.shared.pythonRuntime,
            timeout: Duration.minutes(15),
            tracing: lambda.Tracing.ACTIVE,
        });

        // Add SQS event source to EvaluationExecutor with concurrency control
        // TODO: Consider making batchSize and maxConcurrency configurable via SystemConfig
        evaluationExecutor.addEventSource(
            new SqsEventSource(evaluationQueue, {
                batchSize: 1, // Process one test case at a time
                maxConcurrency: 50, // Throttling limit (prevents overwhelming Bedrock/AgentCore)
                reportBatchItemFailures: true, // Enable partial batch responses
            }),
        );

        // Grant DynamoDB permissions
        props.evaluatorsTable.grantReadWriteData(evaluationResolver);
        props.evaluatorsTable.grantReadWriteData(evaluationExecutor);

        // Grant S3 permissions
        evaluationsBucket.grantReadWrite(evaluationResolver);
        evaluationsBucket.grantReadWrite(evaluationExecutor);

        // Grant SQS permissions
        evaluationQueue.grantSendMessages(evaluationResolver);
        evaluationQueue.grantConsumeMessages(evaluationExecutor);

        // Grant EvaluationExecutor Bedrock AgentCore permissions
        evaluationExecutor.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock-agentcore:InvokeAgentRuntime",
                    "bedrock-agentcore:InvokeAgentRuntimeForUser",
                    "bedrock-agentcore:StopRuntimeSession",
                    "bedrock-agentcore:ListAgentRuntimes",
                    "bedrock-agentcore:GetAgentRuntimeEndpoint",
                    "bedrock-agentcore-control:ListAgentRuntimes",
                    "bedrock-agentcore-control:GetAgentRuntimeEndpoint",
                ],
                resources: ["*"],
            }),
        );

        // Grant EvaluationExecutor Bedrock model invocation permissions
        // Required for Strands Evals SDK which uses LLM for evaluation
        evaluationExecutor.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:Converse",
                    "bedrock:ConverseStream",
                ],
                resources: [
                    // Allow foundation models in all regions (cross-region inference profiles route to different regions)
                    `arn:aws:bedrock:*::foundation-model/*`,
                    // Allow inference profiles in the stack's region
                    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/*`,
                ],
            }),
        );

        // Grant EvaluationExecutor permission to publish to AppSync (for progress updates)
        evaluationExecutor.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["appsync:GraphQL"],
                resources: [
                    `arn:aws:appsync:${stack.region}:${stack.account}:apis/${props.api.apiId}/*`,
                ],
            }),
        );

        // Create AppSync data source
        const evaluationDataSource = props.api.addLambdaDataSource(
            "EvaluationDataSource",
            evaluationResolver,
        );

        // Create resolvers for all evaluation operations using forEach pattern
        // Note: Resolver IDs must match original names to preserve CloudFormation logical IDs
        [
            {
                type: "Query",
                field: "listEvaluators",
                resolverId: "ListEvaluatorsResolver",
            },
            {
                type: "Query",
                field: "getEvaluator",
                resolverId: "GetEvaluatorResolver",
            },
            {
                type: "Mutation",
                field: "createEvaluator",
                resolverId: "CreateEvaluatorResolver",
            },
            {
                type: "Mutation",
                field: "deleteEvaluator",
                resolverId: "DeleteEvaluatorResolver",
            },
            {
                type: "Mutation",
                field: "runEvaluation",
                resolverId: "RunEvaluationResolver",
            },
        ].forEach((op) => {
            evaluationDataSource.createResolver(op.resolverId, {
                typeName: op.type,
                fieldName: op.field,
            });
        });

        this.evaluationResolver = evaluationResolver;
        this.evaluationExecutor = evaluationExecutor;
        this.evaluationsBucket = evaluationsBucket;
        this.evaluationQueue = evaluationQueue;

        NagSuppressions.addResourceSuppressions(
            evaluationResolver,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Lambda needs wildcard permissions for DynamoDB, S3, and SQS operations",
                },
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Using AWS managed policy for Lambda basic execution role is acceptable for this use case",
                },
            ],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            evaluationExecutor,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Lambda needs wildcard permissions for DynamoDB, S3, Bedrock AgentCore, AppSync and evaluation models",
                },
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Using AWS managed policy for Lambda basic execution role is acceptable for this use case",
                },
            ],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            evaluationDataSource,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "AppSync data source requires wildcard permissions to invoke Lambda with any qualifier",
                },
            ],
            true,
        );

        NagSuppressions.addResourceSuppressions(loggingBucket, [
            {
                id: "AwsSolutions-S1",
                reason: "Logging bucket does not require its own server access logging to avoid infinite loop",
            },
        ]);
    }
}
