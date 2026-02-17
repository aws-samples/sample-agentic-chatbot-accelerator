import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { AcaAgentCoreContainer } from "./agent-core";
import { ChatbotApi } from "./api";
import { Authentication } from "./authentication";
import { Cleanup } from "./cleanup";
import { DataProcessing } from "./data-processing";
import { GenAIInterface } from "./genai-interface";
import { VectorKnowledgeBase } from "./knowledge-base";
import { Observability } from "./observability";
import { Shared } from "./shared";
import { Direction, Framework, SystemConfig } from "./shared/types";
import { UserInterface } from "./user-interface";

export interface AcaProps extends cdk.StackProps {
    readonly config: SystemConfig;
}

export class AcaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: AcaProps) {
        super(scope, id, {
            ...props,
            description: "AWS Agentic Chatbot Accelerator (uksb-enc2nrtqd0)",
        });

        // Parameters
        const architectureParam = new cdk.CfnParameter(this, "LambdaArchitecture", {
            type: "String",
            default: "x86_64",
            allowedValues: ["x86_64", "arm64"],
            description: "The Lambda function architecture (x86_64 or arm64)",
        });

        const lambdaArchitecture =
            architectureParam.valueAsString === "arm64"
                ? lambda.Architecture.ARM_64
                : lambda.Architecture.X86_64;
        process.env.DOCKER_DEFAULT_PLATFORM = lambdaArchitecture.dockerPlatform;

        const shared = new Shared(this, "Shared", lambdaArchitecture);

        const dataProcessing = props.config.dataProcessingParameters
            ? new DataProcessing(this, "DataProcessingPipeline", {
                  shared: shared,
                  config: props.config,
                  dataProcessing: props.config.dataProcessingParameters,
              })
            : undefined;

        // Create optional single Knowledge Base
        const knowledgeBase =
            dataProcessing && props.config.knowledgeBaseParameters
                ? new VectorKnowledgeBase(this, "KnowledgeBase", {
                      knowledgeBaseParameters: props.config.knowledgeBaseParameters,
                      config: props.config,
                      dataSourceBucket: dataProcessing.dataBucket,
                      shared: shared,
                  })
                : undefined;

        const auth = new Authentication(this, "Authentication", props.config);

        // temp below
        const agentCoreInfra = new AcaAgentCoreContainer(this, "AgentCoreInfra", {
            shared: shared,
            config: props.config,
            knowledgeBaseId: knowledgeBase?.knowledgeBase.knowledgeBaseId,
        });

        const api = new ChatbotApi(this, "ChatbotApi", {
            shared,
            config: props.config,
            userPool: auth.userPool,
            dataBucket: dataProcessing?.dataBucket,
            documentTable: dataProcessing?.documentTable,
            queueStartPipeline: dataProcessing?.queueStartPipeline,
            kbInventoryTable: knowledgeBase?.kbInventoryTable,
            vectorCollection: knowledgeBase?.vectorCollection,
            kbRole: knowledgeBase?.kbRole,
            // AgentCore
            agentCoreContainer: agentCoreInfra.imageAsset,
            swarmAgentCoreContainer: agentCoreInfra.swarmImageAsset,
            agentCoreExecutionRole: agentCoreInfra.executionRole,
            agentCoreRuntimeTable: agentCoreInfra.agentCoreRuntimeTable,
            agentCoreSummaryTable: agentCoreInfra.agentCoreSummaryTable,
            toolRegistryTable: agentCoreInfra.toolRegistry,
            mcpServerRegistryTable: agentCoreInfra.mcpServerRegistry,
            agentToolsTopic: agentCoreInfra.agentToolsTopic,
        });

        const genaiInterface = new GenAIInterface(this, "GenAIInterface", {
            shared: shared,
            config: props.config,
            sessionsTable: api.sessionsTable,
            byUserIdIndex: api.byUserIndex,
            messagesTopic: api.messagesTopic,
            agentToolsTopic: agentCoreInfra.agentToolsTopic,
        });

        api.messagesTopic.addSubscription(
            new subscriptions.LambdaSubscription(genaiInterface.invokeAgentCoreRuntime, {
                filterPolicyWithMessageBody: {
                    direction: sns.FilterOrPolicy.filter(
                        sns.SubscriptionFilter.stringFilter({
                            allowlist: [Direction.In],
                        }),
                    ),
                    framework: sns.FilterOrPolicy.filter(
                        sns.SubscriptionFilter.stringFilter({
                            allowlist: [Framework.AGENT_CORE],
                        }),
                    ),
                },
            }),
        );

        new UserInterface(this, "UserInterface", {
            config: props.config,
            userPoolId: auth.userPool.userPoolId,
            userPoolClientId: auth.userPoolClient.userPoolClientId,
            identityPool: auth.identityPool,
            api: api,
            dataBucket: dataProcessing?.dataBucket,
        });

        new Cleanup(this, "Cleanup", {
            shared: shared,
            kbInventoryTable: knowledgeBase?.kbInventoryTable,
            knowledgeBase: knowledgeBase,
        });

        if (props.config.agentCoreObservability) {
            new Observability(this, "Observability", {
                enableTransactionSearch:
                    props.config.agentCoreObservability.enableTransactionSearch,
                indexingPercentage: props.config.agentCoreObservability.indexingPercentage,
            });
        }

        // Suppressing CDK-NAG errors:
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            [
                `/${this.stackName}/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/Resource`,
                `/${this.stackName}/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/DefaultPolicy/Resource`,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource`,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource`,
            ],
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
        );

        // BucketNotificationsHandler only exists when dataProcessing is defined (S3 bucket with notifications)
        if (dataProcessing) {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                [
                    `/${this.stackName}/BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/Resource`,
                    `/${this.stackName}/BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/DefaultPolicy/Resource`,
                ],
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
            );
        }
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            [
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
            ],
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "Resource automatically created by CDK.",
                },
            ],
        );
        // Add suppressions for DynamoDB seeder custom resource
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            [`/${this.stackName}/Custom::DynamodbSeederCustomDynamodbSeeder/ServiceRole/Resource`],
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "DynamoDB seeder uses AWS managed policy for Lambda basic execution role. This is a third-party construct from @cloudcomponents/cdk-dynamodb-seeder.",
                },
            ],
        );
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            [`/${this.stackName}/Custom::DynamodbSeederCustomDynamodbSeeder/Resource`],
            [
                {
                    id: "AwsSolutions-L1",
                    reason: "DynamoDB seeder Lambda runtime version is managed by the third-party construct @cloudcomponents/cdk-dynamodb-seeder.",
                },
            ],
        );
    }
}
