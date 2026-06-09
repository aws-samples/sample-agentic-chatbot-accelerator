// -----------------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------------------
//   CodeBuildPipBundle — builds a Python Lambda deployment package via AWS CodeBuild.
//
//   Similar to CodeBuildPipLayer, but instead of producing a layer.zip it produces
//   a Lambda deployment zip containing both the function source code AND pip-installed
//   dependencies.
//
//   Creates the build infrastructure (S3 artifact bucket + CodeBuild project) only.
//   Builds are triggered externally by build.sh (pre-deploy script).
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
 * Properties for CodeBuildPipBundle.
 */
export interface CodeBuildPipBundleProps {
    /** Path to the directory containing the Lambda function source code. */
    readonly directory: string;

    /**
     * Pip packages to install into the deployment package.
     * These are passed to `pip install <packages>`.
     */
    readonly pipPackages: string[];

    /** Lambda runtime (e.g. PYTHON_3_14) — wheels are resolved for this version. */
    readonly runtime: lambda.Runtime;

    /** Lambda architecture (X86_64 or ARM64). */
    readonly architecture: lambda.Architecture;

    /**
     * Patterns to exclude from the source context zip.
     * @default ["__pycache__", "*.pyc", ".pytest_cache"]
     */
    readonly excludes?: string[];

    /** Optional S3 bucket for build artifacts. One is created if omitted. */
    readonly artifactBucket?: s3.IBucket;
}

/**
 * Builds a Python Lambda deployment package via AWS CodeBuild.
 *
 * No local Docker or Python is needed — pip install runs on an Amazon Linux
 * CodeBuild container matching the target Lambda architecture.
 *
 * The build is triggered externally by build.sh, not by a Custom Resource.
 */
export class CodeBuildPipBundle extends Construct {
    /** The S3 bucket containing the built deployment zip. */
    public readonly artifactBucket: s3.IBucket;

    /** The S3 key of the built deployment zip. */
    public readonly artifactKey: string;

    /** The CodeBuild project name (used by build.sh to trigger builds). */
    public readonly projectName: string;

    constructor(scope: Construct, id: string, props: CodeBuildPipBundleProps) {
        super(scope, id);

        const stackName = cdk.Stack.of(this).stackName.toLowerCase();
        const excludes = props.excludes ?? ["__pycache__", "*.pyc", ".pytest_cache"];

        // -----------------------------------------------------------------
        // 1. Upload function source as an S3 asset
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
                bucketName: `${stackName}-pip-bundle-${cdk.Aws.ACCOUNT_ID}`,
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
                reason: "Transient build artifact bucket with 30-day expiry. Server access logs not required for ephemeral pip bundle outputs.",
            },
        ]);

        const artifactKey = `pip-bundle-output/${id}/${sourceAsset.assetHash}/bundle.zip`;

        // -----------------------------------------------------------------
        // 3. CodeBuild project
        // -----------------------------------------------------------------
        const isArm = props.architecture === lambda.Architecture.ARM_64;

        // Lambda runtime name is "python3.14" → "3.14". Wheels for compiled
        // extensions (e.g. pydantic_core) must match the target ABI exactly,
        // so pip is forced to resolve wheels for the Lambda runtime + arch
        // rather than the build host's Python.
        const pythonVersion = props.runtime.name.replace(/^python/, "");
        const platformTag = isArm ? "manylinux2014_aarch64" : "manylinux2014_x86_64";
        const pipInstallCmd = [
            "pip install",
            props.pipPackages.join(" "),
            "-t /tmp/package",
            `--platform ${platformTag}`,
            `--python-version ${pythonVersion}`,
            "--implementation cp",
            "--only-binary=:all:",
            "--quiet",
            "--upgrade",
        ].join(" ");

        const buildSpec = codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
                install: {
                    commands: [
                        'echo "Using Python $(python3 --version)"',
                        "python3 -m pip install --upgrade pip",
                    ],
                },
                build: {
                    commands: [
                        'echo "Installing pip dependencies into deployment package…"',
                        "mkdir -p /tmp/package",
                        pipInstallCmd,
                        'echo "Copying source files…"',
                        "cp -a . /tmp/package/",
                        'echo "Stripping unnecessary files to reduce package size…"',
                        "find /tmp/package -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true",
                        "find /tmp/package -type f -name '*.pyc' -delete 2>/dev/null || true",
                        "find /tmp/package -type d -name tests -exec rm -rf {} + 2>/dev/null || true",
                        "find /tmp/package -type d -name test -exec rm -rf {} + 2>/dev/null || true",
                        'echo "Creating deployment zip…"',
                        "cd /tmp/package && zip -r /tmp/bundle.zip . -q",
                        "ls -lh /tmp/bundle.zip",
                    ],
                },
                post_build: {
                    commands: [
                        `aws s3 cp /tmp/bundle.zip s3://${artifactBucket.bucketName}/${artifactKey}`,
                        `echo "Uploaded to s3://${artifactBucket.bucketName}/${artifactKey}"`,
                    ],
                },
            },
        });

        const cbProject = new codebuild.Project(this, "Project", {
            projectName: `${stackName}-${id}-builder`,
            description: `Builds the ${id} Python Lambda bundle (pip install + source)`,
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
