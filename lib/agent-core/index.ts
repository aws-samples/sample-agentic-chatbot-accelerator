// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import { RuntimeNetworkConfiguration } from "@aws-cdk/aws-bedrock-agentcore-alpha";
import { DynamoDBSeeder, Seeds } from "@cloudcomponents/cdk-dynamodb-seeder";

import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";

import * as sns from "aws-cdk-lib/aws-sns";

import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as crypto from "crypto";
import { Shared } from "../shared";

import * as path from "path";
import { SystemConfig } from "../shared/types";
import { createLambda, generatePrefix, getTagConditions, stableStringify } from "../shared/utils";

interface AcaAgentCoreContainerProps {
    config: SystemConfig;
    readonly shared: Shared;
    readonly knowledgeBaseId: string | undefined;
}

export class AcaAgentCoreContainer extends Construct {
    public readonly imageAsset: DockerImageAsset;
    public readonly executionRole: Role;
    public readonly agentCoreRuntimeTable: dynamodb.Table;
    public readonly toolRegistry: dynamodb.Table;
    public readonly mcpServerRegistry: dynamodb.Table;
    public readonly agentCoreSummaryTable: dynamodb.Table;
    public readonly agentToolsTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: AcaAgentCoreContainerProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        // Table where agents' configuration are stored
        const agentCoreRuntimeTable = new dynamodb.Table(this, "AgentCoreRuntimeCfgTable", {
            tableName: `${prefix}-agentCoreRuntimeCfgTable`,
            partitionKey: {
                name: "AgentName",
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: "CreatedAt",
                type: dynamodb.AttributeType.NUMBER,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });
        agentCoreRuntimeTable.addLocalSecondaryIndex({
            indexName: "byAgentNameAndVersion",
            sortKey: {
                name: "AgentRuntimeVersion",
                type: dynamodb.AttributeType.STRING,
            },
        });

        // Table where tools' specifications are defined
        const toolRegistry = new dynamodb.Table(this, "ToolRegistry", {
            tableName: `${prefix}-toolRegistryTable`,
            partitionKey: {
                name: "ToolName",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });
        new DynamoDBSeeder(this, "ToolsSeeder", {
            table: toolRegistry,
            seeds: Seeds.fromInline(
                props.config.toolRegistry.map((tool) => ({
                    ToolName: tool.name,
                    ToolDescription: tool.description,
                    InvokesSubAgent: tool.invokesSubAgent,
                })),
            ),
        });

        // MCP Server Registry table
        const mcpServerRegistry = new dynamodb.Table(this, "McpServerRegistry", {
            tableName: `${prefix}-mcpServerRegistryTable`,
            partitionKey: {
                name: "McpServerName",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });

        const agentToolsTopic = new sns.Topic(this, "MessagesTopic", {
            topicName: `${prefix}-agentToolsTopic`,
            enforceSSL: true,
        });

        // MCP Server Registry seeder with full lifecycle support (create/update/delete)
        const mcpSeederLambda = createLambda(this, {
            name: `${prefix}-mcp-seeder`,
            asset: "mcp-seeder",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            dir: __dirname,
            envs: {
                MCP_TABLE_NAME: mcpServerRegistry.tableName,
                AWS_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
            },
        });
        mcpServerRegistry.grantReadWriteData(mcpSeederLambda);
        mcpSeederLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["bedrock-agentcore:GetAgentRuntimeEndpoint"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
                ],
            }),
        );
        mcpSeederLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["bedrock-agentcore:GetGateway"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:gateway/*`,
                ],
            }),
        );

        const mcpSeederProvider = new cr.Provider(this, "McpSeederProvider", {
            onEventHandler: mcpSeederLambda,
        });

        // Compute hash from MCP server config to trigger updates on config changes
        const mcpConfigHash = crypto
            .createHash("sha256")
            .update(stableStringify(props.config.mcpServerRegistry))
            .digest("hex");

        // Pass raw server config - URL composition happens in Lambda at runtime
        // to avoid CDK token resolution issues with encodeURIComponent
        new cdk.CustomResource(this, "McpServerRegistrySeed", {
            serviceToken: mcpSeederProvider.serviceToken,
            properties: {
                servers: JSON.stringify(
                    props.config.mcpServerRegistry.map((server) => ({
                        name: server.name,
                        description: server.description,
                        ...("runtimeId" in server && { runtimeId: server.runtimeId }),
                        ...("gatewayId" in server && { gatewayId: server.gatewayId }),
                        ...("qualifier" in server && { qualifier: server.qualifier }),
                    })),
                ),
                configHash: mcpConfigHash, // Forces update when config changes
            },
        });

        NagSuppressions.addResourceSuppressions(
            mcpSeederProvider,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "IAM role implicitly created by CDK for Lambda basic execution.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "IAM role implicitly created by CDK.",
                },
                {
                    id: "AwsSolutions-L1",
                    reason: "Lambda runtime version is managed by CDK custom resource provider framework construct.",
                },
            ],
            true,
        );
        NagSuppressions.addResourceSuppressions(
            mcpSeederLambda,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "IAM role implicitly created by CDK for Lambda basic execution.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "IAM role implicitly created by CDK.",
                },
            ],
            true,
        );

        // Table used to populate data for visual rendering in the UI
        const agentCoreSummaryTable = new dynamodb.Table(this, "AgentCoreSummaryTable", {
            tableName: `${prefix}-agentCoreSummaryTable`,
            partitionKey: {
                name: "AgentName",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });

        // AgentCore runtime container
        const imageAsset = new DockerImageAsset(this, "AgentCoreRepository", {
            assetName: `${prefix}-agent-core`,
            directory: path.join(__dirname, "docker"),
            platform: Platform.LINUX_ARM64,
        });

        const statements = [
            new PolicyStatement({
                sid: "ECRImageAccess",
                actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
                resources: [imageAsset.repository.repositoryArn],
            }),
            new PolicyStatement({
                actions: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
                resources: [
                    `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`,
                ],
            }),
            new PolicyStatement({
                actions: ["logs:DescribeLogGroups"],
                resources: [`arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`],
            }),
            new PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [
                    `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
                ],
            }),
            new PolicyStatement({
                sid: "ECRTokenAccess",
                actions: ["ecr:GetAuthorizationToken"],
                resources: ["*"],
            }),
            new PolicyStatement({
                actions: [
                    "xray:PutTraceSegments",
                    "xray:PutTelemetryRecords",
                    "xray:GetSamplingRules",
                    "xray:GetSamplingTargets",
                ],
                resources: ["*"],
            }),
            new PolicyStatement({
                actions: ["cloudwatch:PutMetricData"],
                resources: ["*"],
                conditions: {
                    StringEquals: {
                        "cloudwatch:namespace": "bedrock-agentcore",
                    },
                },
            }),
            new PolicyStatement({
                sid: "GetAgentAccessToken",
                actions: [
                    "bedrock-agentcore:GetWorkloadAccessToken",
                    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                    "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
                ],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default`,
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`,
                ],
            }),
            new PolicyStatement({
                sid: "BedrockModelInvocation",
                actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources: [
                    "arn:aws:bedrock:*::foundation-model/*",
                    `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
                ],
            }),
            new PolicyStatement({
                sid: "RetrieveFromBedrockKB",
                actions: ["bedrock:Retrieve", "bedrock:GetKnowledgeBase"],
                resources: [`arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
                conditions: {
                    StringEquals: getTagConditions(this),
                },
            }),
            new PolicyStatement({
                sid: "BedrockReranking",
                actions: ["bedrock:Rerank"],
                resources: ["*"],
            }),
            new PolicyStatement({
                sid: "AWSMarketplaceAccess",
                actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
                resources: ["*"],
            }),
            new iam.PolicyStatement({
                sid: "AgentCoreIRuntimeActions",
                actions: [
                    "bedrock-agentcore:InvokeAgentRuntime",
                    "bedrock-agentcore:ListAgentRuntimes",
                    "bedrock-agentcore:InvokeAgentRuntimeForUser",
                ],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
                ],
            }),
            new iam.PolicyStatement({
                sid: "AgentCoreGatewayActions",
                actions: ["bedrock-agentcore:InvokeGateway"],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:gateway/*`,
                ],
            }),
            new iam.PolicyStatement({
                sid: "AgentCoreMemoryActions",
                actions: [
                    "bedrock-agentcore:ListEvents",
                    "bedrock-agentcore:GetMemory",
                    "bedrock-agentcore:CreateEvent",
                    "bedrock-agentcore:ListMemories",
                    "bedrock-agentcore:DeleteMemoryRecord",
                    "bedrock-agentcore:GetMemoryRecord",
                    "bedrock-agentcore:ListMemoryRecords",
                    "bedrock-agentcore:RetrieveMemoryRecords",
                ],
                resources: [
                    `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:memory/*`,
                ],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:GetItem"],
                resources: [agentCoreRuntimeTable.tableArn],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:Scan"],
                resources: [toolRegistry.tableArn, mcpServerRegistry.tableArn],
            }),
            new iam.PolicyStatement({
                sid: "PublishToAgentToolsTopic",
                effect: iam.Effect.ALLOW,
                actions: ["sns:Publish"],
                resources: [agentToolsTopic.topicArn],
            }),
        ];

        const executionRole = new Role(this, "AgentExecutionRole", {
            assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com"),
            roleName: `${prefix}-BedrockAgentCore-execution-role`,
            inlinePolicies: {
                AgentCorePolicy: new PolicyDocument({
                    statements: statements,
                }),
            },
        });

        if (props.config.agentRuntimeConfig) {
            const repository = imageAsset.repository;

            const agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
                repository,
                imageAsset.imageTag,
            );

            const agentName = `${prefix}-default-agent`.replace(/-/g, "_");

            const agentConfig = props.config.agentRuntimeConfig;

            // Compute hash from user-provided config ONLY
            // This ensures consistent hashing across CDK synthesis runs
            const configString = stableStringify(agentConfig);
            const hash = crypto
                .createHash("sha256")
                .update(configString)
                .update(imageAsset.assetHash)
                .digest();
            const createdAt = Number(hash.readBigUInt64BE(0) % BigInt(Number.MAX_SAFE_INTEGER));

            // Enrich tool parameters with runtime values (KB id) AFTER hashing
            const enrichedToolParameters = { ...agentConfig.toolParameters };
            for (const toolName of agentConfig.tools) {
                if (toolName.startsWith("retrieve_from_kb") && props.knowledgeBaseId) {
                    enrichedToolParameters[toolName] = {
                        ...enrichedToolParameters[toolName],
                        kb_id: props.knowledgeBaseId,
                    };
                }
            }
            const configToSeed = {
                ...agentConfig,
                toolParameters: enrichedToolParameters,
            };

            let memory: agentcore.Memory | undefined = undefined;

            if (agentConfig.memoryCfg) {
                memory = new agentcore.Memory(this, "DefaultMemory", {
                    memoryName: `${prefix}-default-memory`.replace(/-/g, "_"),
                    description: agentConfig.memoryCfg.description,
                    expirationDuration: cdk.Duration.days(agentConfig.memoryCfg.retentionDays),
                });
            }

            const runtime = new agentcore.Runtime(this, "DefaultRuntime", {
                runtimeName: agentName,
                description: agentConfig.description,
                agentRuntimeArtifact: agentRuntimeArtifact,
                executionRole: executionRole,
                networkConfiguration: RuntimeNetworkConfiguration.usingPublicNetwork(),
                environmentVariables: {
                    accountId: cdk.Aws.ACCOUNT_ID,
                    agentName: agentName,
                    createdAt: createdAt.toString(),
                    tableName: agentCoreRuntimeTable.tableName,
                    toolRegistry: toolRegistry.tableName,
                    mcpServerRegistry: mcpServerRegistry.tableName,
                    agentToolsTopicArn: agentToolsTopic.topicArn,
                    ...(memory && {
                        memoryId: memory.memoryId,
                    }),
                },
                tags: {
                    Owner: "CDK",
                },
                ...(agentConfig.lifecycleCfg && {
                    lifecycleConfiguration: {
                        idleRuntimeSessionTimeout: cdk.Duration.minutes(
                            agentConfig.lifecycleCfg.idleRuntimeSessionTimeoutInMinutes,
                        ),
                        maxLifetime: cdk.Duration.hours(
                            agentConfig.lifecycleCfg.maxLifetimeInHours,
                        ),
                    },
                }),
            });

            // Create seeder Lambda with custom resource for config-change-aware seeding
            const seederLambda = createLambda(this, {
                name: `${prefix}-agentcore-seeder`,
                asset: "seeder",
                handler: "index.handler",
                timeout: 1,
                memorySize: 128,
                shared: props.shared,
                dir: __dirname,
                envs: {
                    CFG_TABLE_NAME: agentCoreRuntimeTable.tableName,
                    DASHBOARD_TABLE_NAME: agentCoreSummaryTable.tableName,
                },
            });
            agentCoreRuntimeTable.grantWriteData(seederLambda);
            agentCoreSummaryTable.grantReadWriteData(seederLambda);

            const seederProvider = new cr.Provider(this, "SeederProvider", {
                onEventHandler: seederLambda,
            });

            const configHash = hash.toString("hex");
            new cdk.CustomResource(this, "AgentRuntimeSeed", {
                serviceToken: seederProvider.serviceToken,
                properties: {
                    item: JSON.stringify({
                        AgentName: agentName,
                        CreatedAt: createdAt,
                        AgentRuntimeArn: runtime.agentRuntimeArn,
                        AgentRuntimeId: runtime.agentRuntimeId,
                        AgentRuntimeVersion: runtime.agentRuntimeVersion,
                        ConfigurationValue: stableStringify(configToSeed),
                    }),
                    configHash: configHash, // Forces update when config changes
                },
            });

            NagSuppressions.addResourceSuppressions(
                seederProvider,
                [
                    {
                        id: "AwsSolutions-IAM4",
                        reason: "IAM role implicitly created by CDK for Lambda basic execution.",
                    },
                    {
                        id: "AwsSolutions-IAM5",
                        reason: "IAM role implicitly created by CDK.",
                    },
                    {
                        id: "AwsSolutions-L1",
                        reason: "Lambda runtime version is managed by CDK custom resource provider framework construct.",
                    },
                ],
                true,
            );
            NagSuppressions.addResourceSuppressions(
                seederLambda,
                [
                    {
                        id: "AwsSolutions-IAM4",
                        reason: "IAM role implicitly created by CDK for Lambda basic execution.",
                    },
                    {
                        id: "AwsSolutions-IAM5",
                        reason: "IAM role implicitly created by CDK.",
                    },
                ],
                true,
            );
            new CfnOutput(this, "DefaultAgentCoreRuntime", {
                value: runtime.agentRuntimeId,
                description: "Identifier of the default AgentCore Runtime",
            });
        }

        this.agentCoreRuntimeTable = agentCoreRuntimeTable;
        this.toolRegistry = toolRegistry;
        this.mcpServerRegistry = mcpServerRegistry;
        this.agentCoreSummaryTable = agentCoreSummaryTable;
        this.imageAsset = imageAsset;
        this.executionRole = executionRole;
        this.agentToolsTopic = agentToolsTopic;

        new CfnOutput(this, "AgentCoreImageUri", {
            value: this.imageAsset.imageUri,
            description: "AgentCore Docker image URI",
        });
        new CfnOutput(this, "AgentCoreExecutionRole", {
            value: this.executionRole.roleArn,
            description: "Agent Execution Role ARN",
        });

        NagSuppressions.addResourceSuppressions(
            executionRole,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard permissions required for Bedrock AgentCore role management across accounts and regions",
                },
            ],
            true,
        );
    }
}
