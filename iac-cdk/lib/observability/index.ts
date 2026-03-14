// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as xray from "aws-cdk-lib/aws-xray";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { generatePrefix } from "../shared/utils";

export interface ObservabilityProps {
    readonly enableTransactionSearch?: boolean;
    readonly indexingPercentage?: number;
}

/**
 * Observability construct for AgentCore Runtime.
 *
 * This construct enables comprehensive observability for AgentCore agents by setting up:
 * - AWS X-Ray Transaction Search for distributed tracing
 * - CloudWatch Logs integration for span ingestion
 * - Application Signals for automatic agent performance metrics
 *
 * When enabled, this provides:
 * - Automatic agent performance metrics (token usage, errors, latency)
 * - Distributed tracing with session correlation
 * - GenAI Observability dashboard in CloudWatch
 * - Transaction search capabilities for troubleshooting
 *
 * The implementation follows the suggestion at:
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search-Cloudformation.html
 * https://strandsagents.com/latest/documentation/docs/user-guide/deploy/deploy_to_bedrock_agentcore/#step-3-viewing-your-agents-observability-data
 * ```
 */
export class Observability extends Construct {
    constructor(scope: Construct, id: string, props?: ObservabilityProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        const enableTransactionSearch = props?.enableTransactionSearch ?? true;
        const indexingPercentage = props?.indexingPercentage ?? 10; // 10% default

        if (enableTransactionSearch) {
            // Create the resource policy for X-Ray to write to CloudWatch Logs
            const logResourcePolicy = new logs.CfnResourcePolicy(this, "XRayLogResourcePolicy", {
                policyName: "TransactionSearchAccess",
                policyDocument: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Sid: "TransactionSearchXRayAccess",
                            Effect: "Allow",
                            Principal: {
                                Service: "xray.amazonaws.com",
                            },
                            Action: "logs:PutLogEvents",
                            Resource: [
                                `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:aws/spans:*`,
                                `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/application-signals/data:*`,
                            ],
                            Condition: {
                                ArnLike: {
                                    "aws:SourceArn": `arn:${cdk.Aws.PARTITION}:xray:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
                                },
                                StringEquals: {
                                    "aws:SourceAccount": cdk.Aws.ACCOUNT_ID,
                                },
                            },
                        },
                    ],
                }),
            });

            // Create the TransactionSearchConfig with dependency
            const transactionSearchConfig = new xray.CfnTransactionSearchConfig(
                this,
                "XRayTransactionSearchConfig",
                {
                    indexingPercentage: indexingPercentage,
                },
            );

            // Add the dependency to ensure Resource Policy is created first
            transactionSearchConfig.addDependency(logResourcePolicy);

            // Output the configuration details
            new cdk.CfnOutput(this, "TransactionSearchEnabled", {
                value: enableTransactionSearch.toString(),
                description:
                    "Transaction Search is enabled for through CDK AgentCore observability",
            });

            new cdk.CfnOutput(this, "IndexingPercentage", {
                value: indexingPercentage.toString(),
                description: "X-Ray trace indexing percentage",
            });

            // CDK NAG suppressions
            NagSuppressions.addResourceSuppressions(
                logResourcePolicy,
                [
                    {
                        id: "AwsSolutions-IAM5",
                        reason: "Resource policy for X-Ray service to write spans to CloudWatch Logs",
                    },
                ],
                true,
            );

            NagSuppressions.addResourceSuppressions(
                transactionSearchConfig,
                [
                    {
                        id: "AwsSolutions-IAM5",
                        reason: "X-Ray TransactionSearchConfig requires wildcard permissions",
                    },
                ],
                true,
            );
        }

        // Create CloudWatch Dashboard for AgentCore metrics
        const dashboard = new cloudwatch.Dashboard(this, "AgentCoreDashboard", {
            dashboardName: `${prefix}-agentCore-observability`,
        });

        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: "Agent Response Latency",
                width: 12,
                left: [
                    new cloudwatch.MathExpression({
                        expression: "m1/1000",
                        usingMetrics: {
                            m1: new cloudwatch.Metric({
                                namespace: "AWS/Bedrock",
                                metricName: "InvocationLatency",
                                statistic: "Average",
                            }),
                        },
                        label: "Bedrock Latency (s)",
                    }),
                    new cloudwatch.MathExpression({
                        expression: "m2/1000",
                        usingMetrics: {
                            m2: new cloudwatch.Metric({
                                namespace: "AWS/X-Ray",
                                metricName: "ResponseTime",
                                statistic: "p99",
                            }),
                        },
                        label: "X-Ray P99 (s)",
                    }),
                ],
                leftYAxis: { min: 0, label: "Seconds" },
            }),
            new cloudwatch.GraphWidget({
                title: "Error Rate & Faults",
                width: 12,
                left: [
                    new cloudwatch.Metric({
                        namespace: "AWS/Bedrock",
                        metricName: "InvocationErrors",
                        statistic: "Sum",
                        unit: cloudwatch.Unit.COUNT,
                    }),
                    new cloudwatch.Metric({
                        namespace: "AWS/X-Ray",
                        metricName: "ErrorRate",
                        statistic: "Average",
                        unit: cloudwatch.Unit.PERCENT,
                    }),
                ],
                leftYAxis: { min: 0, label: "Count/Percent" },
            }),
        );

        dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: "Token Usage",
                width: 12,
                left: [
                    new cloudwatch.Metric({
                        namespace: "AWS/Bedrock",
                        metricName: "InputTokenCount",
                        statistic: "Sum",
                        unit: cloudwatch.Unit.COUNT,
                    }),
                    new cloudwatch.Metric({
                        namespace: "AWS/Bedrock",
                        metricName: "OutputTokenCount",
                        statistic: "Sum",
                        unit: cloudwatch.Unit.COUNT,
                    }),
                ],
                leftYAxis: { min: 0, label: "Tokens" },
            }),
            new cloudwatch.GraphWidget({
                title: "Invocation Volume",
                width: 12,
                left: [
                    new cloudwatch.Metric({
                        namespace: "AWS/Bedrock",
                        metricName: "Invocations",
                        statistic: "Sum",
                        unit: cloudwatch.Unit.COUNT,
                    }),
                ],
                leftYAxis: { min: 0, label: "Count" },
            }),
        );

        new cdk.CfnOutput(this, "DashboardUrl", {
            value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/cloudwatch/home?region=${cdk.Aws.REGION}#dashboards:name=${dashboard.dashboardName}`,
            description: "CloudWatch Dashboard URL for AgentCore observability",
        });
    }
}
