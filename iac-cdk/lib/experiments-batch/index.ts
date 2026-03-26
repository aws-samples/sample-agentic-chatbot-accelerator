// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import * as batch from "aws-cdk-lib/aws-batch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as path from "path";

import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

export interface ExperimentsBatchProps {
    readonly shared: Shared;
    readonly config: SystemConfig;
    readonly experimentsTableName: string;
    readonly evaluationsBucketName: string;
    /** Optional existing VPC to use for Batch compute. If omitted, a new VPC is created. */
    readonly vpc?: ec2.IVpc;
}

export class ExperimentsBatch extends Construct {
    public readonly jobQueue: batch.IJobQueue;
    public readonly jobDefinition: batch.IJobDefinition;
    public readonly computeEnvironment: batch.IComputeEnvironment;
    public readonly batchImage: DockerImageAsset;

    constructor(scope: Construct, id: string, props: ExperimentsBatchProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        // Build Batch-specific Docker image
        this.batchImage = new DockerImageAsset(this, "BatchImage", {
            assetName: `${prefix}-experiments-batch`,
            directory: path.join(__dirname, "../../../src/experiments-batch/docker"),
            platform: Platform.LINUX_ARM64,
        });

        // Use provided VPC or create a new one for Batch compute environment
        let vpc: ec2.IVpc;

        if (props.vpc) {
            vpc = props.vpc;
        } else {
            const newVpc = new ec2.Vpc(this, "BatchVpc", {
                maxAzs: 2,
                natGateways: 1,
            });

            // Add VPC Flow Logs for security compliance
            const flowLogRole = new iam.Role(this, "FlowLogRole", {
                assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
            });

            const flowLogGroup = new logs.LogGroup(this, "FlowLogGroup", {
                retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            flowLogGroup.grantWrite(flowLogRole);

            new ec2.FlowLog(this, "FlowLog", {
                resourceType: ec2.FlowLogResourceType.fromVpc(newVpc),
                destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup, flowLogRole),
            });

            // Suppress VPC flow log warning (only for VPCs we create)
            NagSuppressions.addResourceSuppressions(
                newVpc,
                [
                    {
                        id: "AwsSolutions-VPC7",
                        reason: "VPC Flow Logs are enabled for the Batch VPC.",
                    },
                ],
                true,
            );

            vpc = newVpc;
        }

        // Create IAM role for Batch job execution
        const jobRole = new iam.Role(this, "ExperimentJobRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            description: "Role for AWS Batch experiment generation jobs",
        });

        // Grant permissions to access DynamoDB and S3
        jobRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                resources: [
                    `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${props.experimentsTableName}`,
                ],
            }),
        );

        jobRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject"],
                resources: [`arn:aws:s3:::${props.evaluationsBucketName}/*`],
            }),
        );

        // Grant Bedrock model access for test case generation
        jobRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:Converse",
                    "bedrock:ConverseStream",
                ],
                resources: [
                    `arn:aws:bedrock:*::foundation-model/*`,
                    `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                    `arn:aws:bedrock:*::inference-profile/*`,
                ],
            }),
        );

        // Create execution role for Batch
        const executionRole = new iam.Role(this, "ExperimentJobExecutionRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy",
                ),
            ],
        });

        // Create CloudWatch log group
        const logGroup = new logs.LogGroup(this, "ExperimentJobLogs", {
            logGroupName: `/aws/batch/${prefix}-experiments`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create Batch Compute Environment (Fargate)
        this.computeEnvironment = new batch.FargateComputeEnvironment(
            this,
            "ExperimentComputeEnv",
            {
                vpc,
                maxvCpus: 4,
            },
        );

        // Create Job Queue
        this.jobQueue = new batch.JobQueue(this, "ExperimentJobQueue", {
            computeEnvironments: [
                {
                    computeEnvironment: this.computeEnvironment,
                    order: 1,
                },
            ],
        });

        // Create Job Definition (Fargate with small compute)
        this.jobDefinition = new batch.EcsJobDefinition(this, "ExperimentJobDef", {
            container: new batch.EcsFargateContainerDefinition(this, "ExperimentContainer", {
                image: ecs.ContainerImage.fromDockerImageAsset(this.batchImage),
                memory: cdk.Size.mebibytes(2048), // 2GB
                cpu: 1, // 1 vCPU
                jobRole,
                executionRole,
                fargatePlatformVersion: ecs.FargatePlatformVersion.LATEST,
                environment: {
                    EXPERIMENTS_TABLE_NAME: props.experimentsTableName,
                    EXPERIMENTS_BUCKET_NAME: props.evaluationsBucketName,
                    EXPERIMENTS_S3_PREFIX: "experiments/generated-cases",
                    AWS_REGION: cdk.Aws.REGION,
                },
                logging: ecs.LogDriver.awsLogs({
                    streamPrefix: "experiment",
                    logGroup,
                }),
            }),
        });

        // Override the runtime platform to ARM64 using CFN escape hatch
        const cfnJobDef = this.jobDefinition.node.defaultChild as batch.CfnJobDefinition;
        cfnJobDef.addPropertyOverride("ContainerProperties.RuntimePlatform", {
            CpuArchitecture: "ARM64",
            OperatingSystemFamily: "LINUX",
        });

        // CDK NAG Suppressions
        NagSuppressions.addResourceSuppressions(
            jobRole,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard permissions required for Bedrock model access.",
                },
            ],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            executionRole,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "AWS managed policy required for ECS task execution.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard permissions required for ECR image pull and CloudWatch logs.",
                },
            ],
            true,
        );
    }
}
