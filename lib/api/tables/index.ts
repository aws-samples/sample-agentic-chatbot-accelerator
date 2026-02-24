// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { generatePrefix } from "../../shared/utils";

/**
 * Represents DynamoDB tables used by the chatbot application
 *
 * Creates and configures a DynamoDB table for storing chat sessions with the following:
 *  - Partition key: SessionId (String)
 *  - Sort key: UserId (String)
 */
export class ChatbotDynamoDBTables extends Construct {
    public readonly sessionsTable: dynamodb.Table;
    public readonly favoriteRuntimeTable: dynamodb.Table;
    public readonly evaluatorsTable: dynamodb.Table;
    public readonly byUserIdIndex: string = "byUserId";

    constructor(scope: Construct, id: string) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const sessionsTable = new dynamodb.Table(this, "DevSessionsTable", {
            tableName: `${prefix}-sessionsTable`,
            partitionKey: {
                name: "SessionId",
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: "UserId",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });

        sessionsTable.addGlobalSecondaryIndex({
            indexName: this.byUserIdIndex,
            partitionKey: {
                name: "UserId",
                type: dynamodb.AttributeType.STRING,
            },
        });

        // Favorite configurations Table
        const favoriteTable = new dynamodb.Table(this, "FavoriteRuntime", {
            tableName: `${prefix}-favoriteRuntimeTable`,
            partitionKey: {
                name: "UserId",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });

        const evaluatorsTable = new dynamodb.Table(this, "EvaluatorsTable", {
            tableName: `${prefix}-evaluatorsTable`,
            partitionKey: {
                name: "EvaluatorName",
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });

        this.sessionsTable = sessionsTable;
        this.favoriteRuntimeTable = favoriteTable;
        this.evaluatorsTable = evaluatorsTable;
    }
}
