// -----------------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// -----------------------------------------------------------------------------------
//   CodeBuildDockerImage — builds & pushes a Docker image via AWS CodeBuild.
//
//   Creates the build infrastructure (ECR repo + CodeBuild project) only.
//   Builds are triggered externally by build.sh (pre-deploy script).
//   No Custom Resources — no Lambda, no Step Function waiter overhead.
// -----------------------------------------------------------------------------------

import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import * as crypto from "crypto";

/**
 * Properties for CodeBuildDockerImage.
 */
export interface CodeBuildDockerImageProps {
    /** Path to the directory containing the Dockerfile and build context. */
    readonly directory: string;

    /**
     * Relative path to the Dockerfile within `directory`.
     * @default "Dockerfile"
     */
    readonly file?: string;

    /**
     * Target platform for the Docker image.
     * @default "linux/arm64"
     */
    readonly platform?: string;

    /**
     * Patterns to exclude from the build context zip.
     * @default [".git", "__pycache__", "*.pyc"]
     */
    readonly excludes?: string[];

    /**
     * Whether to build for ARM64.  Determines the CodeBuild compute type.
     * @default true
     */
    readonly arm?: boolean;
}

/**
 * Creates an ECR repository and a CodeBuild project for building a Docker image.
 * The build is triggered externally (by build.sh), not by a Custom Resource.
 */
export class CodeBuildDockerImage extends Construct {
    /** The ECR repository holding the built image. */
    public readonly repository: ecr.Repository;

    /** The content-based image tag. */
    public readonly imageTag: string;

    /** Full image URI (repository URL + tag). */
    public readonly imageUri: string;

    /** The CodeBuild project name (used by build.sh to trigger builds). */
    public readonly projectName: string;

    constructor(scope: Construct, id: string, props: CodeBuildDockerImageProps) {
        super(scope, id);

        const stackName = cdk.Stack.of(this).stackName.toLowerCase();
        const dockerfilePath = props.file ?? "Dockerfile";
        const platform = props.platform ?? "linux/arm64";
        const isArm = props.arm ?? true;
        const excludes = props.excludes ?? [".git", "__pycache__", "*.pyc"];

        // -----------------------------------------------------------------
        // 1. Upload Docker build context as an S3 asset
        // -----------------------------------------------------------------
        const contextAsset = new s3assets.Asset(this, "Context", {
            path: props.directory,
            exclude: excludes,
        });

        // Compute a short content-based tag from the asset hash
        this.imageTag = crypto
            .createHash("sha256")
            .update(contextAsset.assetHash)
            .digest("hex")
            .slice(0, 16);

        // -----------------------------------------------------------------
        // 2. ECR repository
        // -----------------------------------------------------------------
        this.repository = new ecr.Repository(this, "Repo", {
            repositoryName: `${stackName}/${id.toLowerCase()}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            lifecycleRules: [
                {
                    maxImageCount: 10,
                    description: "Keep at most 10 images",
                },
            ],
        });

        this.imageUri = `${this.repository.repositoryUri}:${this.imageTag}`;

        // -----------------------------------------------------------------
        // 3. CodeBuild project (privileged for Docker builds)
        // -----------------------------------------------------------------
        const buildSpec = codebuild.BuildSpec.fromObject({
            version: "0.2",
            env: {
                variables: {
                    ECR_REPO_URL: this.repository.repositoryUri,
                    AWS_DEFAULT_REGION: cdk.Aws.REGION,
                    AWS_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
                },
            },
            phases: {
                pre_build: {
                    commands: [
                        'echo "Authenticating to ECR…"',
                        "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com",
                        'echo "IMAGE_TAG=$IMAGE_TAG"',
                    ],
                },
                build: {
                    commands: [
                        'echo "Building Docker image…"',
                        `docker build --platform ${platform} -f "${dockerfilePath}" -t "$ECR_REPO_URL:$IMAGE_TAG" .`,
                        'echo "Build complete."',
                    ],
                },
                post_build: {
                    commands: [
                        'echo "Pushing image to ECR…"',
                        'docker push "$ECR_REPO_URL:$IMAGE_TAG"',
                        'echo "Image pushed successfully."',
                    ],
                },
            },
        });

        const cbProject = new codebuild.Project(this, "Project", {
            projectName: `${stackName}-${id}-builder`,
            description: `Builds and pushes the ${id} Docker image to ECR`,
            timeout: cdk.Duration.minutes(30),
            source: codebuild.Source.s3({
                bucket: contextAsset.bucket,
                path: contextAsset.s3ObjectKey,
            }),
            buildSpec,
            environment: {
                computeType: codebuild.ComputeType.SMALL,
                buildImage: isArm
                    ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0
                    : codebuild.LinuxBuildImage.STANDARD_7_0,
                privileged: true, // Required for Docker-in-Docker
                environmentVariables: {
                    IMAGE_TAG: { value: this.imageTag },
                },
            },
        });

        this.projectName = cbProject.projectName;

        // Grant CodeBuild: read source, push to ECR
        contextAsset.bucket.grantRead(cbProject);
        this.repository.grantPullPush(cbProject);

        // ECR GetAuthorizationToken is needed for docker login
        cbProject.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["ecr:GetAuthorizationToken"],
                resources: ["*"],
            }),
        );

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
                    id: "AwsSolutions-CB3",
                    reason: "Privileged mode is required for Docker-in-Docker builds.",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "CodeBuild service role requires wildcard for ecr:GetAuthorizationToken and CloudWatch Logs.",
                },
            ],
            true,
        );
    }
}
