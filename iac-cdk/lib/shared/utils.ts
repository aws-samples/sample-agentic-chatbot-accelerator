/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/

import * as fs from "node:fs";
import * as path from "node:path";

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";

import { Construct } from "constructs";
import { Shared } from ".";
/**
 * Utility class providing static helper methods for file system operations.
 * This class is abstract and cannot be instantiated.
 */
export abstract class Utils {
    /**
     * Recursively copies a directory and all its contents to a target location.
     * Creates the target directory if it doesn't exist.
     *
     * @param sourceDir - The path to the source directory to copy from
     * @param targetDir - The path to the target directory to copy to
     * @throws {Error} If source directory doesn't exist or if filesystem operations fail
     */
    static copyDirRecursive(sourceDir: string, targetDir: string): void {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir);
        }

        const files = fs.readdirSync(sourceDir);

        for (const file of files) {
            const sourceFilePath = path.join(sourceDir, file);
            const targetFilePath = path.join(targetDir, file);
            const stats = fs.statSync(sourceFilePath);

            if (stats.isDirectory()) {
                Utils.copyDirRecursive(sourceFilePath, targetFilePath);
            } else {
                fs.copyFileSync(sourceFilePath, targetFilePath);
            }
        }
    }
}

/**
 * Generates a prefix string by combining an optional prefix with the lowercase stack name.
 *
 * @param construct - The CDK construct to get the stack name from
 * @param prefix - Optional prefix to prepend to the stack name
 * @returns The generated prefix string, either "{prefix}-{stack-name}" if prefix provided, or just "{stack-name}"
 */
export function generatePrefix(construct: Construct): string {
    return cdk.Stack.of(construct).stackName.toLowerCase();
}

export function getTagConditions(construct: Construct): Record<string, string> {
    const stackName = cdk.Stack.of(construct).stackName;
    const environment = stackName.split("-")[0];
    const stackType = stackName.split("-")[1]?.replace("Stack", "") || "aca";

    const tagConditions: Record<string, string> = {
        "aws:ResourceTag/Stack": stackType.toLowerCase(),
    };

    if (environment.toLowerCase() !== "aca") {
        tagConditions["aws:ResourceTag/Environment"] = environment.toLowerCase();
    }
    return tagConditions;
}

/**
 * Properties for configuring a Lambda function
 * @interface LambdaProps
 * @property {string} name - The name of the Lambda function
 * @property {string} [asset] - The path to the Lambda function code asset
 * @property {string} handler - The handler function name
 * @property {number} timeout - The function timeout in minutes
 * @property {number} memorySize - The function memory size in MB
 * @property {Shared} shared - Shared construct properties
 * @property {Record<string,string>} envs - Environment variables for the function
 * @property {string} [dir] - Directory containing the Lambda function code
 * @property {boolean} [createQueue] - Whether to create a dead-letter SQS queue for the function
 * @property {lambda.ILayerVersion[]} [layers] - Additional Lambda layers to add to the function
 * @property {boolean} [image] - Whether the function uses a container image
 * @property {ec2.Vpc} [vpc] - VPC to deploy the function into
 * @property {ec2.SecurityGroup[]} [securityGroups] - Security groups to assign to the function
 * @property {lambda.Code | lambda.DockerImageCode} [code] - Lambda function code
 */
interface LambdaProps {
    readonly name: string;
    readonly asset?: string;
    readonly handler: string;
    readonly timeout: number;
    readonly memorySize: number;
    readonly shared: Shared;
    readonly envs: Record<string, string>;
    readonly dir?: string;
    readonly createQueue?: boolean;
    readonly layers?: lambda.ILayerVersion[];
    readonly image?: boolean;
    readonly vpc?: ec2.Vpc;
    readonly securityGroups?: ec2.SecurityGroup[];
    readonly code?: lambda.Code | lambda.DockerImageCode;
    readonly reservedConcurrentExecutions?: number;
}

export function createLambda(construct: Construct, props: LambdaProps) {
    let dlq = undefined;
    if (props.createQueue === true) {
        dlq = new sqs.Queue(construct, `${props.name}-dlq`, {
            queueName: `${props.name}-dlq`,
            retentionPeriod: cdk.Duration.days(3),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
        });
    }

    if (props.image && props.layers) {
        throw new Error("Layers are not supported for container image functions");
    }

    if (props.image && props.code && props.code instanceof lambda.Code) {
        throw new Error(
            "When image is true and code is provided, code must be lambda.DockerImageCode",
        );
    }

    if (props.image && props.code && props.code instanceof lambda.Code) {
        throw new Error(
            "When image is false/undefined and code is provided, code must be lambda.Code",
        );
    }

    if ((props.dir && props.asset && props.code) || (!(props.dir && props.asset) && !props.code)) {
        throw new Error("Must provide either (dir and asset) or code, but not both");
    }

    const logGroup = new logs.LogGroup(construct, `${props.name}LogGroup`, {
        logGroupName: `/aws/lambda/${props.name}-lg`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const common = {
        functionName: props.name,
        timeout: cdk.Duration.minutes(props.timeout),
        architecture: props.shared.lambdaArchitecture,
        memorySize: props.memorySize,
        logGroup: logGroup,
        environment: props.envs,
        tracing: lambda.Tracing.ACTIVE,
        deadLetterQueue: dlq,
        deadLetterQueueEnabled: props.createQueue,
        vpc: props.vpc,
        securityGroups: props.securityGroups ? props.securityGroups : undefined,
        reservedConcurrentExecutions: props.reservedConcurrentExecutions,
    };

    const lambdaFunc = props.image
        ? new lambda.DockerImageFunction(construct, props.name, {
              code:
                  (props.code as lambda.DockerImageCode) ||
                  lambda.DockerImageCode.fromImageAsset(
                      path.join(props.dir!, `./functions/${props.asset}`),
                  ),
              ...common,
          })
        : new lambda.Function(construct, props.name, {
              handler: props.handler,
              code:
                  (props.code as lambda.Code) ||
                  props.shared.sharedCode.bundleWithLambdaAsset(
                      path.join(props.dir!, `./functions/${props.asset}`),
                  ),
              runtime: props.shared.pythonRuntime,

              layers: [
                  props.shared.powerToolsLayer,
                  props.shared.boto3Layer,
                  ...(props.layers || []),
              ],
              ...common,
          });

    if (props.vpc) {
        if (props.vpc) {
            lambdaFunc.addToRolePolicy(
                new iam.PolicyStatement({
                    actions: [
                        "ec2:CreateNetworkInterface",
                        "ec2:DeleteNetworkInterface",
                        "ec2:DescribeNetworkInterfaces",
                    ],
                    resources: ["*"],
                    conditions: {
                        "ForAllValues:StringEquals": {
                            "aws:ResourceTag/aws-cdk-vpc-endpoint": `VPC=${props.vpc.vpcId}`,
                        },
                    },
                }),
            );
        }
    }

    if (dlq) {
        dlq.grantSendMessages(lambdaFunc);
    }

    return lambdaFunc;
}

interface QueueProps {
    readonly name: string;
    readonly visibilityTimeout: number;
    readonly maxReceiveCount: number;
}

export function createQueue(construct: Construct, props: QueueProps) {
    const dlq = new sqs.Queue(construct, `${props.name}-dlq`, {
        queueName: `${props.name}-dlq`,
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    return new sqs.Queue(construct, `${props.name}-queue`, {
        queueName: `${props.name}-queue`,
        visibilityTimeout: cdk.Duration.minutes(props.visibilityTimeout),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: {
            queue: dlq,
            maxReceiveCount: props.maxReceiveCount,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
}

/**
 * A Map subclass that automatically creates and sets default values for missing keys.
 * Similar to Python's collections.defaultdict.
 *
 * @typeparam K - The type of keys in the map
 * @typeparam V - The type of values in the map
 */
export class DefaultMap<K, V> extends Map<K, V> {
    /**
     * Creates a new DefaultMap instance
     * @param defaultFactory - A function that returns the default value for missing keys
     */
    constructor(private defaultFactory: () => V) {
        super();
    }

    /**
     * Gets the value for a key, creating and setting a default value if the key doesn't exist
     * @param key - The key to look up
     * @returns The value associated with the key, or a new default value if the key was missing
     */
    get(key: K): V {
        if (!this.has(key)) {
            this.set(key, this.defaultFactory());
        }
        return super.get(key)!;
    }
}

/**
 * Recursively serializes an object to JSON with deterministic key ordering.
 * Ensures consistent hash values across multiple runs by sorting object keys alphabetically.
 *
 * @param obj - The value to serialize
 * @returns A deterministic JSON string representation
 * @throws {TypeError} If the object contains circular references
 */
export function stableStringify(obj: unknown): string {
    const seen = new WeakSet<object>();

    function stringify(value: unknown): string {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }

        if (seen.has(value)) {
            throw new TypeError("Converting circular structure to JSON");
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return "[" + value.map(stringify).join(",") + "]";
        }

        const sortedKeys = Object.keys(value).sort();
        const pairs = sortedKeys.map(
            (key) => JSON.stringify(key) + ":" + stringify((value as Record<string, unknown>)[key]),
        );
        return "{" + pairs.join(",") + "}";
    }

    return stringify(obj);
}
