/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of `Shared` construct

Credits for this file go to the author of https://github.com/aws-samples/aws-genai-llm-chatbot
*/
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "path";
import { SharedAssetBundler } from "./shared-asset-bundler";

const pythonRuntime = lambda.Runtime.PYTHON_3_14;
const powerToolsLayerVersion = "27";

/**
 * Properties for the Shared construct.
 */
export interface SharedProps {
    readonly lambdaArchitecture: lambda.Architecture;
    /** S3 bucket containing the boto3 layer artifact (from BuilderStack). */
    readonly boto3LayerBucket: s3.IBucket;
    /** S3 key of the boto3 layer.zip artifact (from BuilderStack). */
    readonly boto3LayerKey: string;
}

/**
 * Shared utilities for Lambda functions
 */
export class Shared extends Construct {
    readonly defaultEnvironmentVariables: Record<string, string>;
    readonly pythonRuntime: lambda.Runtime = pythonRuntime;
    readonly lambdaArchitecture: lambda.Architecture;
    readonly boto3Layer: lambda.ILayerVersion;
    readonly powerToolsLayer: lambda.ILayerVersion;
    readonly sharedCode: SharedAssetBundler;

    constructor(scope: Construct, id: string, props: SharedProps) {
        super(scope, id);

        this.lambdaArchitecture = props.lambdaArchitecture;

        this.defaultEnvironmentVariables = {
            POWERTOOLS_DEV: "false",
            LOG_LEVEL: "INFO",
            POWERTOOLS_LOGGER_LOG_EVENT: "true",
            POWERTOOLS_SERVICE_NAME: "aca",
        };

        const powerToolsArn =
            this.lambdaArchitecture === lambda.Architecture.X86_64
                ? `arn:${cdk.Aws.PARTITION}:lambda:${
                      cdk.Aws.REGION
                  }:017000801446:layer:AWSLambdaPowertoolsPythonV3-${pythonRuntime.name.replace(
                      ".",
                      "",
                  )}-x86_64:${powerToolsLayerVersion}`
                : `arn:${cdk.Aws.PARTITION}:lambda:${
                      cdk.Aws.REGION
                  }:017000801446:layer:AWSLambdaPowertoolsPythonV3-${pythonRuntime.name.replace(
                      ".",
                      "",
                  )}-arm64:${powerToolsLayerVersion}`;

        const powerToolsLayer = lambda.LayerVersion.fromLayerVersionArn(
            this,
            "PowertoolsLayer",
            powerToolsArn,
        );

        // Create LayerVersion from the pre-built artifact (built by BuilderStack + build.sh)
        const boto3Layer = new lambda.LayerVersion(this, "Boto3Layer", {
            code: lambda.Code.fromBucket(props.boto3LayerBucket, props.boto3LayerKey),
            compatibleRuntimes: [pythonRuntime],
            compatibleArchitectures: [props.lambdaArchitecture],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.sharedCode = new SharedAssetBundler(this, "genai-core", [
            path.join(__dirname, "../../../src/shared/layers", "python-sdk", "genai_core"),
        ]);
        this.powerToolsLayer = powerToolsLayer;
        this.boto3Layer = boto3Layer;
    } // End of construct
}
