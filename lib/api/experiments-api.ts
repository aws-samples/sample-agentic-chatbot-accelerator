// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
// ----------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";

import { ExperimentsBatch } from "../experiments-batch";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

export interface ExperimentOpsProps {
    readonly api: appsync.GraphqlApi;
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly experimentsTable: dynamodb.Table;
    readonly evaluationsBucket: s3.Bucket;
}

export class ExperimentOps extends Construct {
    readonly operations: string[];
    readonly batch: ExperimentsBatch;

    constructor(scope: Construct, id: string, props: ExperimentOpsProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        this.operations = [];

        // Create AWS Batch infrastructure for experiment generation
        this.batch = new ExperimentsBatch(this, "Batch", {
            shared: props.shared,
            config: props.config,
            experimentsTableName: props.experimentsTable.tableName,
            evaluationsBucketName: props.evaluationsBucket.bucketName,
        });

        // Create CloudWatch log group for the ExperimentResolver
        const resolverLogGroup = new logs.LogGroup(this, "ExperimentResolverLogGroup", {
            logGroupName: `/aws/lambda/${prefix}-experiment-resolver`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Lambda resolver for Experiment operations
        const experimentResolver = new lambda.Function(this, "ExperimentResolver", {
            runtime: props.shared.pythonRuntime,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "functions/experiment-resolver")),
            timeout: Duration.minutes(15),
            memorySize: 256,
            logGroup: resolverLogGroup,
            architecture: props.shared.lambdaArchitecture,
            layers: [props.shared.powerToolsLayer, props.shared.boto3Layer],
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                ...props.shared.defaultEnvironmentVariables,
                EXPERIMENTS_TABLE_NAME: props.experimentsTable.tableName,
                EXPERIMENTS_BUCKET_NAME: props.evaluationsBucket.bucketName,
                ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
                BATCH_JOB_QUEUE: this.batch.jobQueue.jobQueueName,
                BATCH_JOB_DEFINITION: this.batch.jobDefinition.jobDefinitionName,
            },
        });

        // Grant permissions
        props.experimentsTable.grantReadWriteData(experimentResolver);
        props.evaluationsBucket.grantReadWrite(experimentResolver);

        // Grant permissions to submit Batch jobs
        experimentResolver.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["batch:SubmitJob", "batch:DescribeJobs", "batch:TerminateJob"],
                resources: [
                    this.batch.jobQueue.jobQueueArn,
                    // Allow all job definitions in the account (needed for SubmitJob)
                    `arn:aws:batch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:job-definition/*`,
                    // Allow all job instances
                    `arn:aws:batch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:job/*`,
                ],
            }),
        );

        // Create AppSync data source
        const experimentDataSource = props.api.addLambdaDataSource(
            "ExperimentResolverDataSource",
            experimentResolver,
            {
                name: `${prefix}-experimentResolverDataSource`,
            },
        );

        // Associate resolver to operations
        const operations = [
            { type: "Query", field: "listExperiments" },
            { type: "Query", field: "getExperiment" },
            { type: "Query", field: "getExperimentPresignedUrl" },
            { type: "Mutation", field: "createExperiment" },
            { type: "Mutation", field: "updateExperiment" },
            { type: "Mutation", field: "deleteExperiment" },
            { type: "Mutation", field: "runExperiment" },
        ];

        operations.forEach((op) => {
            props.api.createResolver(`${op.field}-resolver`, {
                typeName: op.type,
                fieldName: op.field,
                dataSource: experimentDataSource,
            });
            this.operations.push(op.field);
        });

        // CDK NAG Suppressions for Lambda
        NagSuppressions.addResourceSuppressions(
            experimentResolver,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Lambda uses AWS managed policy for basic execution role.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard permissions required for DynamoDB indexes, Lambda self-invocation, and AgentCore runtime operations.",
                },
            ],
            true,
        );

        // CDK NAG Suppressions for AppSync Data Source
        NagSuppressions.addResourceSuppressions(
            experimentDataSource,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "AppSync data source requires wildcard permissions for Lambda invocation.",
                },
            ],
            true,
        );
    }
}
