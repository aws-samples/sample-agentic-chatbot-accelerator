/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of `Shared` construct

Credits for this file go to the author of https://github.com/aws-samples/aws-genai-llm-chatbot
*/
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";
import { Layer } from "../layer";
import { SharedAssetBundler } from "./shared-asset-bundler";

const pythonRuntime = lambda.Runtime.PYTHON_3_14;
const powerToolsLayerVersion = "27";

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

    constructor(scope: Construct, id: string, lambdaArchitectureId: lambda.Architecture) {
        super(scope, id);

        this.lambdaArchitecture = lambdaArchitectureId;

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

        const boto3Layer = new Layer(this, "Boto3Latest", {
            runtime: pythonRuntime,
            architecture: this.lambdaArchitecture,
            path: path.join(__dirname, "./layers/boto3-latest"),
        });

        this.sharedCode = new SharedAssetBundler(this, "genai-core", [
            path.join(__dirname, "layers", "python-sdk", "genai_core"),
        ]);
        this.powerToolsLayer = powerToolsLayer;
        this.boto3Layer = boto3Layer.layer;
    } // End of construct
}
