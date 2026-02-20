// -------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -------------------------------------------------------------------------
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";

import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { Shared } from "../shared";
import { DataProcessingParameters, SystemConfig } from "../shared/types";
import { createLambda, createQueue, generatePrefix } from "../shared/utils";
import { SfnSteps } from "./steps";

/**
 * Properties for the DataProcessing construct
 * @interface DataProcessingProps
 * @property {Shared} shared - Shared resources and configurations used across the application
 * @property {SystemConfig} config - CDK configuration parameters and settings
 * @property {DataProcessingParameters} dataProcessing - Data Processing Parameters
 */
interface DataProcessingProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly dataProcessing: DataProcessingParameters;
}

/**
 * DataProcessing class that sets up infrastructure for processing data to make them ingestible to a knowledge base
 *
 * @export
 * @class DataProcessing
 * @extends {Construct}
 *
 * @property {dynamodb.Table} documentTable - DynamoDB table for storing document processing state
 * @property {s3.Bucket} dataBucket - S3 bucket for storing input and processed data
 * @property {sqs.Queue} queueStartPipeline - Queue for data processing start
 */
export class DataProcessing extends Construct {
    public readonly documentTable: dynamodb.Table;
    public readonly dataBucket: s3.Bucket;
    public readonly queueStartPipeline: sqs.Queue;

    constructor(scope: Construct, id: string, props: DataProcessingProps) {
        super(scope, id);

        const prefix = generatePrefix(scope);

        this.dataBucket = this.createDataBucket(prefix);
        this.documentTable = this.createDocumentTable(prefix);
        this.queueStartPipeline = this.createStateMachineQueue(
            props.shared,
            prefix,
            this.dataBucket,
            this.documentTable,
        );

        // S3 event trigger
        const s3InputEventRule = new events.Rule(this, `${prefix}-s3DataProcessing`, {
            ruleName: `${prefix}-s3DataProcessing`,
            eventPattern: {
                source: ["aws.s3"],
                detailType: ["Object Created", "Object Deleted"],
                detail: {
                    bucket: { name: [this.dataBucket.bucketName] },
                    object: { key: [{ prefix: `${props.dataProcessing.inputPrefix}/` }] },
                },
            },
        });

        const stack = cdk.Stack.of(this);

        s3InputEventRule.addTarget(
            new targets.SqsQueue(this.queueStartPipeline, {
                message: events.RuleTargetInput.fromObject({
                    bucket: events.EventField.fromPath("$.detail.bucket.name"),
                    key: events.EventField.fromPath("$.detail.object.key"),
                    s3RequestTimestamp: events.EventField.fromPath("$.time"),
                    etag: events.EventField.fromPath("$.detail.object.etag"),
                    detailType: events.EventField.fromPath("$.detail-type"),

                    prefixInput: props.dataProcessing.inputPrefix,
                    prefixDataSource: props.dataProcessing.dataSourcePrefix,
                    prefixProcessing: props.dataProcessing.processingPrefix,
                    midfixStaging: props.dataProcessing.stagingMidfix,
                    midfixTranscribe: props.dataProcessing.transcribeMidfix,
                    transcribeJobPrefix: stack.stackName
                        .toLowerCase()
                        .replace(/[^a-z0-9._-]+/g, "-"),
                    stackName: stack.stackName,
                    languageCode: props.dataProcessing.languageCode,
                }),
            }),
        );
    }

    /**
     * Creates a Step Functions state machine with logging and tracing enabled
     */
    private createStateMachineQueue(
        shared: Shared,
        prefix: string,
        dataBucket: s3.Bucket,
        documentTable: dynamodb.Table,
    ): sqs.Queue {
        const stack = cdk.Stack.of(this);

        // step construct
        const steps = new SfnSteps(this, "stepFunctionSteps", {
            shared: shared,
            prefix: prefix,
            dataBucket: dataBucket,
            documentTable: documentTable,
        });

        const substitutions = {
            lambdaReadTranscribe: steps.funcReadTranscribe.functionArn,
            tableDocumentProcessingState: documentTable.tableArn,
            lambdaCreateMetadataFile: steps.funcCreateMetadataFile.functionArn,
            lambdaReadJson: steps.funcReadJson.functionArn,
        };

        const name = "processData";
        const processingStateMachineLogGroup = new logs.LogGroup(
            this,
            `${prefix}-${name}-LogGroup`,
            {
                logGroupName: `/aws/${prefix}/states/${name}/logs`,
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            },
        );

        const definitionId = "data-processing";
        const stateMachine = new sfn.StateMachine(this, `${prefix}-${name}-StateMachine`, {
            definitionBody: sfn.DefinitionBody.fromFile(
                path.join(__dirname, `./state-machines/${definitionId}.json`),
            ),
            definitionSubstitutions: substitutions,
            stateMachineName: `${prefix}-${name}`,
            logs: {
                destination: processingStateMachineLogGroup,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        // start pipeline
        const funcStartPipeline = createLambda(this, {
            name: `${prefix}-dataProcessing-startPipeline`,
            asset: "pipeline-start",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: shared,
            dir: __dirname,
            envs: {
                STATE_MACHINE_ARN: stateMachine.stateMachineArn,
            },
        });

        const queueStartPipeline = createQueue(this, {
            name: `${prefix}-startPipeline`,
            maxReceiveCount: 3,
            visibilityTimeout: 3,
        });

        queueStartPipeline.addToResourcePolicy(
            new iam.PolicyStatement({
                actions: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
                principals: [new iam.ServicePrincipal("events.amazonaws.com")],
                conditions: {
                    ArnEquals: {
                        "aws:SourceArn": `arn:aws:events:${stack.region}:${stack.account}:rule/*`,
                    },
                },
                resources: [queueStartPipeline.queueArn],
            }),
        );

        funcStartPipeline.addEventSource(
            new eventsources.SqsEventSource(queueStartPipeline, {
                batchSize: 20,
                maxBatchingWindow: cdk.Duration.seconds(10),
            }),
        );

        // Permissions
        dataBucket.grantReadWrite(stateMachine);
        documentTable.grantReadWriteData(stateMachine);
        steps.funcCreateMetadataFile.grantInvoke(stateMachine);
        steps.funcReadTranscribe.grantInvoke(stateMachine);
        steps.funcReadJson.grantInvoke(stateMachine);
        stateMachine.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    "transcribe:StartTranscriptionJob",
                    "transcribe:GetTranscriptionJob",
                    "transcribe:ListTranscriptionJobs",
                    "transcribe:TagResource",
                ],
                resources: [`arn:aws:transcribe:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
            }),
        );

        funcStartPipeline.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["states:StartExecution"],
                resources: [stateMachine.stateMachineArn],
            }),
        );

        NagSuppressions.addResourceSuppressions(
            funcStartPipeline,
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
            stateMachine,
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

        return queueStartPipeline;
    }

    /**
     * Creates an S3 bucket to host input and processed data with appropriate security settings and logging configuration
     */
    private createDataBucket(prefix: string): s3.Bucket {
        const removalCondition = ["prod-", "prd-", "live-"].some((p) =>
            prefix.toLowerCase().startsWith(p.toLowerCase()),
        )
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY;
        const autoDeleteObjects = removalCondition === cdk.RemovalPolicy.DESTROY;

        const stack = cdk.Stack.of(this);

        const loggingBucket = new s3.Bucket(this, "logsDataBucket", {
            bucketName: `${prefix}-logging-data-${stack.region}-${stack.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
        });

        return new s3.Bucket(this, "DataBucket", {
            bucketName: `${prefix}-data-${stack.region}-${stack.account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
            enforceSSL: true,
            serverAccessLogsBucket: loggingBucket,
            serverAccessLogsPrefix: `/aws/${prefix}/data-bucket/logs`,
            eventBridgeEnabled: true,
        });
    }

    /**
     * Creates a DynamoDB table to store document processing state information
     */
    private createDocumentTable(prefix: string): dynamodb.Table {
        const removalCondition = ["prod-", "prd-", "live-"].some((p) =>
            prefix.toLowerCase().startsWith(p.toLowerCase()),
        )
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY;

        return new dynamodb.Table(this, "DataProcessingStateTable", {
            tableName: `${prefix}-document-state`,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            partitionKey: {
                name: "DocumentId",
                type: dynamodb.AttributeType.STRING,
            },
            removalPolicy: removalCondition,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });
    }
}
