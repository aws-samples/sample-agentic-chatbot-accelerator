// -----------------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------------------
//   CodeBuildPipLayer — builds a Python Lambda layer via AWS CodeBuild.
//
//   Creates the build infrastructure (S3 bucket + CodeBuild project + LayerVersion)
//   only.  Builds are triggered externally by build.sh (pre-deploy script).
//   No Custom Resources — no Lambda, no Step Function waiter overhead.
// -----------------------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

/**
 * Properties for CodeBuildPipLayer.
 */
export interface CodeBuildPipLayerProps {
    /** Path to the directory containing requirements.txt. */
    readonly requirementsDir: string;

    /** Lambda runtime (e.g. PYTHON_3_14). */
    readonly runtime: lambda.Runtime;

    /** Lambda architecture (X86_64 or ARM64). */
    readonly architecture: lambda.Architecture;

    /** Optional S3 bucket for build artifacts.  One is created if omitted. */
    readonly artifactBucket?: s3.IBucket;
}

/**
 * Builds a Python Lambda layer via AWS CodeBuild.
 *
 * No local Docker is needed — pip install runs on an Amazon Linux
 * CodeBuild container matching the target Lambda architecture.
 *
 * The build is triggered externally by build.sh, not by a Custom Resource.
 */
export class CodeBuildPipLayer extends Construct {
    /** The S3 bucket containing the built layer.zip artifact. */
    public readonly artifactBucket: s3.IBucket;

    /** The S3 key of the built layer.zip artifact. */
    public readonly artifactKey: string;

    /** The CodeBuild project name (used by build.sh to trigger builds). */
    public readonly projectName: string;

    constructor(scope: Construct, id: string, props: CodeBuildPipLayerProps) {
        super(scope, id);

        const stackName = cdk.Stack.of(this).stackName.toLowerCase();

        // -----------------------------------------------------------------
        // 1. Upload requirements.txt as an S3 asset
        // -----------------------------------------------------------------
        const sourceAsset = new s3assets.Asset(this, "Source", {
            path: props.requirementsDir,
        });

        // -----------------------------------------------------------------
        // 2. Artifact bucket (create or reuse)
        // -----------------------------------------------------------------
        const artifactBucket =
            props.artifactBucket ??
            new s3.Bucket(this, "ArtifactBucket", {
                bucketName: `${stackName}-layer-builds-${cdk.Aws.ACCOUNT_ID}`,
                enforceSSL: true,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                lifecycleRules: [
                    {
                        expiration: cdk.Duration.days(30),
                        noncurrentVersionExpiration: cdk.Duration.days(7),
                        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                    },
                ],
                versioned: true,
            });

        NagSuppressions.addResourceSuppressions(artifactBucket, [
            {
                id: "AwsSolutions-S1",
                reason: "Transient build artifact bucket with 30-day expiry. Server access logs not required for ephemeral layer build outputs.",
            },
        ]);

        const artifactKey = `layer-output/${id}/${sourceAsset.assetHash}/layer.zip`;

        // -----------------------------------------------------------------
        // 3. CodeBuild project
        // -----------------------------------------------------------------
        const isArm = props.architecture === lambda.Architecture.ARM_64;

        const buildSpec = codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
                install: {
                    "runtime-versions": { python: "3.12" },
                },
                build: {
                    commands: [
                        'echo "Building Lambda layer…"',
                        "mkdir -p python",
                        "pip install -r requirements.txt -t python/ --quiet",
                        "find python -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true",
                        "find python -type f -name '*.pyc' -delete 2>/dev/null || true",
                        "find python -type d -name tests -exec rm -rf {} + 2>/dev/null || true",
                        "find python -type d -name test -exec rm -rf {} + 2>/dev/null || true",
                        "zip -r layer.zip python -q",
                        "ls -lh layer.zip",
                    ],
                },
                post_build: {
                    commands: [
                        `aws s3 cp layer.zip s3://${artifactBucket.bucketName}/${artifactKey}`,
                        `echo "Uploaded to s3://${artifactBucket.bucketName}/${artifactKey}"`,
                    ],
                },
            },
        });

        const cbProject = new codebuild.Project(this, "Project", {
            projectName: `${stackName}-${id}-builder`,
            description: `Builds the ${id} Lambda layer (pip install)`,
            timeout: cdk.Duration.minutes(15),
            source: codebuild.Source.s3({
                bucket: sourceAsset.bucket,
                path: sourceAsset.s3ObjectKey,
            }),
            buildSpec,
            environment: {
                computeType: codebuild.ComputeType.SMALL,
                buildImage: isArm
                    ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0
                    : codebuild.LinuxBuildImage.STANDARD_7_0,
            },
        });

        this.projectName = cbProject.projectName;

        // Grant CodeBuild: read source from CDK asset bucket, write to artifact bucket
        sourceAsset.bucket.grantRead(cbProject);
        artifactBucket.grantPut(cbProject);

        // Expose artifact location — LayerVersion is created in AcaStack
        // after build.sh has populated the artifact.
        this.artifactBucket = artifactBucket;
        this.artifactKey = artifactKey;

        // -----------------------------------------------------------------
        // CDK Nag suppressions
        // -----------------------------------------------------------------
        NagSuppressions.addResourceSuppressions(
            cbProject,
            [
                {
                    id: "AwsSolutions-CB4",
                    reason: "Build artifacts are encrypted at rest via S3 SSE. KMS CMK not required for transient build resources.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "CodeBuild service role requires wildcard permissions for CloudWatch Logs created at build time.",
                },
            ],
            true,
        );
    }
}
