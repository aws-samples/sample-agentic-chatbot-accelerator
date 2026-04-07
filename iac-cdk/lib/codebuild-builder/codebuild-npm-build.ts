// -----------------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------------------
//   CodeBuildNpmBuild — builds an npm project (e.g. React app) via AWS CodeBuild.
//
//   Creates the build infrastructure (S3 artifact bucket + CodeBuild project) only.
//   Builds are triggered externally by build.sh (pre-deploy script).
//   No Custom Resources — no Lambda, no Step Function waiter overhead.
// -----------------------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

/**
 * Properties for CodeBuildNpmBuild.
 */
export interface CodeBuildNpmBuildProps {
    /** Path to the directory containing package.json and the source code. */
    readonly directory: string;

    /**
     * The npm script to run for building (e.g. "build", "build:prod").
     * @default "build"
     */
    readonly buildScript?: string;

    /**
     * The output directory produced by the build, relative to the project root.
     * @default "dist"
     */
    readonly outputDir?: string;

    /**
     * Patterns to exclude from the source context zip.
     * @default ["node_modules", ".git", "dist", "*.pyc", "__pycache__"]
     */
    readonly excludes?: string[];

    /**
     * Node.js version for the CodeBuild runtime.
     * @default "22"
     */
    readonly nodeVersion?: string;

    /**
     * Optional S3 bucket for build artifacts.  One is created if omitted.
     */
    readonly artifactBucket?: s3.IBucket;
}

/**
 * Builds an npm project via AWS CodeBuild and uploads the output to S3.
 *
 * No local Node.js or npm is needed for the build — it runs on a managed
 * CodeBuild container. The build is triggered externally by build.sh,
 * not by a Custom Resource.
 */
export class CodeBuildNpmBuild extends Construct {
    /** The S3 bucket containing the built artifact zip. */
    public readonly artifactBucket: s3.IBucket;

    /** The S3 key of the built artifact zip. */
    public readonly artifactKey: string;

    /** The CodeBuild project name (used by build.sh to trigger builds). */
    public readonly projectName: string;

    constructor(scope: Construct, id: string, props: CodeBuildNpmBuildProps) {
        super(scope, id);

        const stackName = cdk.Stack.of(this).stackName.toLowerCase();
        const buildScript = props.buildScript ?? "build";
        const outputDir = props.outputDir ?? "dist";
        const nodeVersion = props.nodeVersion ?? "22";
        const excludes = props.excludes ?? [
            "node_modules",
            ".git",
            "dist",
            "*.pyc",
            "__pycache__",
        ];

        // -----------------------------------------------------------------
        // 1. Upload project source as an S3 asset
        // -----------------------------------------------------------------
        const sourceAsset = new s3assets.Asset(this, "Source", {
            path: props.directory,
            exclude: excludes,
        });

        // -----------------------------------------------------------------
        // 2. Artifact bucket (create or reuse)
        // -----------------------------------------------------------------
        const artifactBucket =
            props.artifactBucket ??
            new s3.Bucket(this, "ArtifactBucket", {
                bucketName: `${stackName}-npm-builds-${cdk.Aws.ACCOUNT_ID}`,
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
                reason: "Transient build artifact bucket with 30-day expiry. Server access logs not required for ephemeral npm build outputs.",
            },
        ]);

        const artifactKey = `npm-build-output/${id}/${sourceAsset.assetHash}/build.zip`;

        // -----------------------------------------------------------------
        // 3. CodeBuild project
        // -----------------------------------------------------------------
        const buildSpec = codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
                install: {
                    "runtime-versions": { nodejs: nodeVersion },
                    commands: [
                        'echo "Installing npm dependencies…"',
                        "npm ci --prefer-offline",
                    ],
                },
                build: {
                    commands: [
                        `echo "Running npm run ${buildScript}…"`,
                        `npm run ${buildScript}`,
                    ],
                },
                post_build: {
                    commands: [
                        `echo "Packaging ${outputDir}/ …"`,
                        `cd ${outputDir} && zip -r ../build.zip . -q && cd ..`,
                        `aws s3 cp build.zip s3://${artifactBucket.bucketName}/${artifactKey}`,
                        `echo "Uploaded to s3://${artifactBucket.bucketName}/${artifactKey}"`,
                    ],
                },
            },
        });

        const cbProject = new codebuild.Project(this, "Project", {
            projectName: `${stackName}-${id}-builder`,
            description: `Builds the ${id} npm project and uploads output to S3`,
            timeout: cdk.Duration.minutes(15),
            source: codebuild.Source.s3({
                bucket: sourceAsset.bucket,
                path: sourceAsset.s3ObjectKey,
            }),
            buildSpec,
            environment: {
                computeType: codebuild.ComputeType.SMALL,
                buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
            },
        });

        this.projectName = cbProject.projectName;

        // Grant CodeBuild: read source from CDK asset bucket, write to artifact bucket
        sourceAsset.bucket.grantRead(cbProject);
        artifactBucket.grantPut(cbProject);

        // Expose artifact location — consumed by AcaStack after build.sh completes
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
