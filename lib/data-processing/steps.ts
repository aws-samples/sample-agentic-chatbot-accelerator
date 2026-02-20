// -------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -------------------------------------------------------------------------

import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";

import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { Shared } from "../shared";
import { createLambda, generatePrefix } from "../shared/utils";

/**
 * Properties for the SfnSteps construct
 * @interface SfnStepsProps
 * @property {Shared} shared - Shared resources and configurations
 * @property {prefix} prefix - Resource name prefix
 * @property {s3.Bucket} dataBucket - S3 bucket for storing data files
 * @property {dynamodb.Table} documentTable - DynamoDB table for document metadata
 */
interface SfnStepsProps {
    readonly shared: Shared;
    readonly prefix: string;
    readonly dataBucket: s3.Bucket;
    readonly documentTable: dynamodb.Table;
}

/**
 * SfnSteps class represents a construct for managing AWS Step Functions workflow steps
 * and associated resources for data processing and transcription.
 *
 * @class SfnSteps
 * @extends {Construct}
 *
 * @property {lambda.Function} funcCreateMetadataFile - Lambda function to create metadata files
 * @property {lambda.Function} funcReadTranscribe - Lambda function read/parse the transcribe output to text
 * @property {lambda.Function} funcReadJson - Lambda function read/parse formatted json
 */
export class SfnSteps extends Construct {
    public readonly funcCreateMetadataFile: lambda.Function;
    public readonly funcReadTranscribe: lambda.Function;
    public readonly funcReadJson: lambda.Function;

    constructor(scope: Construct, id: string, props: SfnStepsProps) {
        super(scope, id);

        const prefix = generatePrefix(this);

        this.funcCreateMetadataFile = createLambda(this, {
            name: `${prefix}-dataProcessing-createMetadataFile`,
            asset: "create-metadata-file",
            handler: "index.handler",
            timeout: 1,
            memorySize: 128,
            shared: props.shared,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
                TABLE_NAME: props.documentTable.tableName,
            },
            dir: __dirname,
            createQueue: true,
        });
        props.documentTable.grantReadData(this.funcCreateMetadataFile);
        props.dataBucket.grantWrite(this.funcCreateMetadataFile);

        /* Transcribe read/parse*/
        this.funcReadTranscribe = createLambda(this, {
            name: `${prefix}-dataProcessing-readTranscribe`,
            asset: "transcribe-read",
            handler: "index.handler",
            timeout: 1,
            memorySize: 256,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        props.dataBucket.grantReadWrite(this.funcReadTranscribe);

        this.funcReadJson = createLambda(this, {
            name: `${prefix}-dataProcessing-readJson`,
            asset: "json-read",
            handler: "index.handler",
            timeout: 1,
            memorySize: 256,
            shared: props.shared,
            dir: __dirname,
            envs: {
                ...props.shared.defaultEnvironmentVariables,
            },
        });
        props.dataBucket.grantReadWrite(this.funcReadJson);

        [this.funcCreateMetadataFile, this.funcReadTranscribe, this.funcReadJson].forEach(
            (func) => {
                NagSuppressions.addResourceSuppressions(
                    func,
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
            },
        );
    }
}
