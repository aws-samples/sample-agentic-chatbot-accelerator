/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition Lambda layer constructs

Credits for this file go to the author of https://github.com/aws-samples/aws-genai-llm-chatbot

Source file: https://github.com/aws-samples/aws-genai-llm-chatbot/blob/main/lib/layer/index.ts
*/
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";

/**
 * Interface for layer properties
 *
 * Defines the properties required for a Lambda layer.
 */
interface LayerProps {
    /**
     * The runtime environment for the layer
     *
     * Must be a valid Lambda runtime such as 'nodejs12.x'
     */
    runtime: lambda.Runtime;

    /**
     * The architecture of the layer
     *
     * Must be a valid Lambda architecture such as 'x86_64'
     */
    architecture: lambda.Architecture;

    /**
     * The path to the layer code package
     *
     * The location of the layer code on disk
     */
    path: string;

    /**
     * Whether to automatically upgrade the layer on deploy
     *
     * Optional boolean, defaults to false if not provided
     */
    autoUpgrade?: boolean;
}

/**
 * Layer class that represents a Lambda layer
 *
 * This class defines a Lambda layer that can be deployed. It takes
 * in properties for the layer and deploys a version to AWS Lambda.
 */
export class Layer extends Construct {
    /**
     * The deployed Lambda layer version
     */
    public layer: lambda.LayerVersion;

    constructor(scope: Construct, id: string, props: LayerProps) {
        super(scope, id);

        const { runtime, architecture, path, autoUpgrade } = props;

        const args = ["-t /asset-output/python"];
        if (autoUpgrade) {
            args.push("--upgrade");
        }

        const ecr = runtime.bundlingImage.image + `:latest-${architecture.toString()}`;
        const layerAsset = new s3assets.Asset(this, "LayerAsset", {
            path,
            bundling: {
                image: new cdk.DockerImage(ecr),
                platform: architecture.dockerPlatform,
                command: ["bash", "-c", `pip install -r requirements.txt ${args.join(" ")}`],
                outputType: cdk.BundlingOutput.AUTO_DISCOVER,
                securityOpt: "no-new-privileges:true",
                network: "host",
            },
        });

        this.layer = new lambda.LayerVersion(this, "Layer", {
            code: lambda.Code.fromBucket(layerAsset.bucket, layerAsset.s3ObjectKey),
            compatibleRuntimes: [runtime],
            compatibleArchitectures: [architecture],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
    }
}
