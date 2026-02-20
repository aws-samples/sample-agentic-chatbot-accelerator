// -------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -------------------------------------------------------------------------
import {
    bedrock,
    opensearchserverless as oss,
    opensearch_vectorindex as osvi,
} from "@cdklabs/generative-ai-cdk-constructs";
import { DynamoDBSeeder, Seeds } from "@cloudcomponents/cdk-dynamodb-seeder";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { Shared } from "../shared";
import { ChunkingStrategyType, KnowledgeBaseParameters, SystemConfig } from "../shared/types";
import { createLambda, createQueue, generatePrefix } from "../shared/utils";

/**
 * Properties for initializing a VectorKnowledgeBase construct
 * @interface VectorKnowledgeBaseProps
 * @property {KnowledgeBaseParameters} knowledgeBaseParameters - Parameters for configuring the knowledge base including embedding model and chunking strategy
 * @property {SystemConfig} config - CDK System configuration that contains settings for the knowledge base
 * @property {s3.Bucket} dataSourceBucket - S3 bucket containing the source data to be ingested
 * @property {Shared} shared - Shared resources and configurations used across the stack
 */
interface VectorKnowledgeBaseProps {
    readonly knowledgeBaseParameters: KnowledgeBaseParameters;
    readonly config: SystemConfig;
    readonly dataSourceBucket: s3.Bucket;
    readonly shared: Shared;
}

/**
 * VectorKnowledgeBase class that sets up a Bedrock Knowledge Base with OpenSearch Serverless vector store
 *
 * @export
 * @class VectorKnowledgeBase
 * @extends {Construct}
 *
 * @property {bedrock.VectorKnowledgeBase} knowledgeBase - The Bedrock Knowledge Base
 * @property {events.Rule} s3DataSourceRule - EventBridge rule for S3 data source events
 * @property {dynamodb.Table} kbInventoryTable - DynamoDB table for KB inventory
 * @property {sqs.Queue} queueSyncPipeline - SQS queue for sync operations
 * @property {lambda.Function} funcStartSync - Lambda function for starting sync
 * @property {oss.VectorCollection} vectorCollection - OpenSearch Serverless vector collection
 * @property {iam.Role} kbRole - IAM role for the Knowledge Base
 */
export class VectorKnowledgeBase extends Construct {
    public readonly knowledgeBase: bedrock.VectorKnowledgeBase;
    public readonly s3DataSourceRule: events.Rule;
    public readonly kbInventoryTable: dynamodb.Table;
    public readonly queueSyncPipeline: sqs.Queue;
    public readonly funcStartSync: lambda.Function;
    public readonly vectorCollection: oss.VectorCollection;
    public readonly kbRole: iam.Role;

    constructor(scope: Construct, id: string, props: VectorKnowledgeBaseProps) {
        super(scope, id);

        if (props.config.dataProcessingParameters === undefined) {
            throw new Error(
                "dataProcessingParameters is required in config for VectorKnowledgeBase",
            );
        }

        const prefix = generatePrefix(scope);
        const kbName = "kb";

        // Create resources
        this.vectorCollection = this.createOssVectorStore(prefix);
        this.kbInventoryTable = this.createInventoryTable(prefix);
        [this.queueSyncPipeline, this.funcStartSync] = this.createSyncQueue(
            props.shared,
            prefix,
            this.kbInventoryTable,
        );
        this.kbRole = this.createKbRole(prefix, props.dataSourceBucket, this.vectorCollection);

        const embeddingModelConfig = props.knowledgeBaseParameters.embeddingModel;

        if (
            embeddingModelConfig.modelId.startsWith("cohere.") &&
            embeddingModelConfig.vectorDimension !== 1024
        ) {
            throw new Error("Cohere embedding models only support 1024 dimensions");
        }

        const embeddingModel = new bedrock.BedrockFoundationModel(embeddingModelConfig.modelId, {
            supportsKnowledgeBase: true,
            vectorDimensions: embeddingModelConfig.vectorDimension,
        });

        const vectorField = "vector-field";
        const indexName = `${prefix}-${kbName}-index`;
        const vectorIndex = new osvi.VectorIndex(this, "vectorIndex", {
            collection: this.vectorCollection,
            indexName: indexName,
            vectorField: vectorField,
            vectorDimensions: embeddingModelConfig.vectorDimension,
            mappings: [],
            precision: "float",
            distanceType: "l2",
        });

        this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, "knowledgeBase", {
            embeddingsModel: embeddingModel,
            name: `${prefix}-${kbName}`,
            vectorStore: this.vectorCollection,
            vectorIndex: vectorIndex,
            vectorField: vectorField,
            indexName: indexName,
            description:
                props.knowledgeBaseParameters.description ||
                "Knowledge Base for searching helpful information.",
            existingRole: this.kbRole,
        });

        let chunkingStrategy = undefined;
        let chunkingStrategyProps = undefined;

        if (
            props.knowledgeBaseParameters.chunkingStrategy.type === ChunkingStrategyType.FIXED_SIZE
        ) {
            chunkingStrategyProps =
                props.knowledgeBaseParameters.chunkingStrategy.fixedChunkingProps;
            if (chunkingStrategyProps === undefined) {
                throw new Error("Missing mandatory properties for fixed chunking");
            }

            chunkingStrategy = bedrock.ChunkingStrategy.fixedSize({
                maxTokens: chunkingStrategyProps.maxTokens,
                overlapPercentage: chunkingStrategyProps.overlapPercentage,
            });
        } else if (
            props.knowledgeBaseParameters.chunkingStrategy.type ===
            ChunkingStrategyType.HIERARCHICAL
        ) {
            chunkingStrategyProps =
                props.knowledgeBaseParameters.chunkingStrategy.hierarchicalChunkingProps;
            if (chunkingStrategyProps === undefined) {
                throw new Error("Missing mandatory properties for hierarchical chunking");
            }
            chunkingStrategy = bedrock.ChunkingStrategy.hierarchical({
                overlapTokens: chunkingStrategyProps.overlapTokens,
                maxParentTokenSize: chunkingStrategyProps.maxParentTokenSize,
                maxChildTokenSize: chunkingStrategyProps.maxChildTokenSize,
            });
        } else if (
            props.knowledgeBaseParameters.chunkingStrategy.type === ChunkingStrategyType.SEMANTIC
        ) {
            chunkingStrategyProps =
                props.knowledgeBaseParameters.chunkingStrategy.semanticChunkingProps;
            if (chunkingStrategyProps === undefined) {
                throw new Error("Missing mandatory properties for semantic chunking");
            }

            chunkingStrategy = bedrock.ChunkingStrategy.semantic({
                bufferSize: chunkingStrategyProps.bufferSize,
                breakpointPercentileThreshold: chunkingStrategyProps.breakpointPercentileThreshold,
                maxTokens: chunkingStrategyProps.maxTokens,
            });
        } else if (
            props.knowledgeBaseParameters.chunkingStrategy.type === ChunkingStrategyType.NONE
        ) {
            chunkingStrategy = bedrock.ChunkingStrategy.NONE;
        } else {
            throw new Error(
                `Add implementation for chunking strategy type ${props.knowledgeBaseParameters.chunkingStrategy.type}`,
            );
        }

        const dataSourcePrefix = props.knowledgeBaseParameters.dataSourcePrefix;

        // Create single S3 data source
        const dataSource = new bedrock.S3DataSource(this, "dataSource", {
            dataSourceName: `${prefix}-${kbName}-dataSource`,
            bucket: props.dataSourceBucket,
            knowledgeBase: this.knowledgeBase,
            description: "S3 Data Source for the Knowledge Base.",
            inclusionPrefixes: [dataSourcePrefix],
            chunkingStrategy: chunkingStrategy,
        });

        // Create EventBridge rule for S3 events
        this.s3DataSourceRule = new events.Rule(this, "s3DataSource-rule", {
            ruleName: `${prefix}-${kbName}-s3DataSource`,
            eventPattern: {
                source: ["aws.s3"],
                detailType: ["Object Created", "Object Deleted"],
                detail: {
                    bucket: { name: [props.dataSourceBucket.bucketName] },
                    object: { key: [{ prefix: `${dataSourcePrefix}/` }] },
                },
            },
        });

        this.s3DataSourceRule.addTarget(
            new targets.SqsQueue(this.queueSyncPipeline, {
                message: events.RuleTargetInput.fromObject({
                    bucket: events.EventField.fromPath("$.detail.bucket.name"),
                    key: events.EventField.fromPath("$.detail.object.key"),
                    s3RequestTimestamp: events.EventField.fromPath("$.time"),
                    knowledgeBaseId: this.knowledgeBase.knowledgeBaseId,
                    dataSourceId: dataSource.dataSourceId,
                }),
            }),
        );

        // Seed the inventory table with KB info
        new DynamoDBSeeder(this, "knowledgeBaseTableSeeder", {
            table: this.kbInventoryTable,
            seeds: Seeds.fromInline([
                {
                    KnowledgeBaseId: this.knowledgeBase.knowledgeBaseId,
                    DataSourceId: dataSource.dataSourceId,
                    DataSourcePrefix: dataSourcePrefix,
                    S3DataProcessingRuleName: this.s3DataSourceRule.ruleName,
                    RawInputPrefix: props.config.dataProcessingParameters.inputPrefix,
                },
            ]),
        });

        // Grant Bedrock permissions
        this.funcStartSync.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    "bedrock:StartIngestionJob",
                    "bedrock:GetIngestionJob",
                    "bedrock:ListIngestionJobs",
                ],
                resources: [this.knowledgeBase.knowledgeBaseArn],
            }),
        );
    }

    private createOssVectorStore(prefix: string): oss.VectorCollection {
        return new oss.VectorCollection(this, "OssVectorCollection", {
            collectionName: `${prefix.toLowerCase().replace(/[^a-z0-9-]/g, "")}-knowledgebase`,
            description: `Knowledge Base Vector Collection`,
            collectionType: oss.VectorCollectionType.VECTORSEARCH,
        });
    }

    private createKbRole(
        prefix: string,
        bucket: s3.Bucket,
        ossVectorCollection: oss.VectorCollection,
    ): iam.Role {
        const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
            roleName: `${prefix}-kbRole`,
            assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com").withConditions({
                StringEquals: {
                    "aws:SourceAccount": cdk.Aws.ACCOUNT_ID,
                },
                ArnLike: {
                    "aws:SourceArn": `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`,
                },
            }),
        });

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock:CreateKnowledgeBase"],
                resources: ["*"],
            }),
        );

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock:DeleteKnowledgeBase",
                    "bedrock:TagResource",
                    "bedrock:UpdateKnowledgeBase",
                ],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`,
                ],
            }),
        );

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["iam:PassRole"],
                resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/${prefix}-kbRole`],
            }),
        );

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock:InvokeModel"],
                resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`],
            }),
        );

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetBucket*", "s3:GetObject*", "s3:List*"],
                resources: [
                    `arn:aws:s3:::${bucket.bucketName}`,
                    `arn:aws:s3:::${bucket.bucketName}/*`,
                ],
            }),
        );

        kbRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["aoss:APIAccessAll"],
                resources: [ossVectorCollection.collectionArn],
            }),
        );

        return kbRole;
    }

    private createInventoryTable(prefix: string): dynamodb.Table {
        return new dynamodb.Table(this, "KnowledgeBaseInventory", {
            tableName: `${prefix}-knowledgeBaseInventory`,
            partitionKey: { name: "KnowledgeBaseId", type: dynamodb.AttributeType.STRING },
            sortKey: { name: "DataSourceId", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });
    }

    private createSyncQueue(
        shared: Shared,
        prefix: string,
        kbInventoryTable: dynamodb.Table,
    ): [sqs.Queue, lambda.Function] {
        const funcStartSync = createLambda(this, {
            name: `${prefix}-syncKnowledgeBase`,
            asset: "sync-knowledgebase",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: shared,
            dir: __dirname,
            envs: {
                KNOWLEDGEBASE_TABLE_NAME: kbInventoryTable.tableName,
            },
        });
        kbInventoryTable.grantReadWriteData(funcStartSync);

        const queueSyncPipeline = createQueue(this, {
            name: `${prefix}-syncKnowledgeBase`,
            maxReceiveCount: 3,
            visibilityTimeout: 3,
        });

        funcStartSync.addEventSource(
            new eventsources.SqsEventSource(queueSyncPipeline, {
                batchSize: 10,
                maxBatchingWindow: cdk.Duration.seconds(10),
                reportBatchItemFailures: true,
            }),
        );

        NagSuppressions.addResourceSuppressions(
            funcStartSync,
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

        return [queueSyncPipeline, funcStartSync];
    }
}
