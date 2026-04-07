// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//   BuilderStack — CodeBuild build infrastructure.
//
//   Deployed BEFORE AcaStack.  Contains only:
//     • CodeBuild projects (Docker images + pip layers + npm builds)
//     • ECR repositories
//     • S3 artifact buckets
//
//   After this stack is deployed, build.sh triggers all builds in parallel.
//   Then AcaStack is deployed, consuming the built artifacts.
// ----------------------------------------------------------------------
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";

import { CodeBuildDockerImage } from "./codebuild-builder";
import { CodeBuildNpmBuild } from "./codebuild-builder";
import { CodeBuildPipLayer } from "./codebuild-builder";

const pythonRuntime = lambda.Runtime.PYTHON_3_14;

export interface BuilderStackProps extends cdk.StackProps {
    readonly lambdaArchitecture: lambda.Architecture;
}

/**
 * Stack containing only CodeBuild build infrastructure.
 * Outputs are consumed by AcaStack after build.sh runs the builds.
 */
export class BuilderStack extends cdk.Stack {
    // Docker images
    public readonly agentCoreImage: CodeBuildDockerImage;
    public readonly swarmImage: CodeBuildDockerImage;
    public readonly graphImage: CodeBuildDockerImage;
    public readonly agentsAsToolsImage: CodeBuildDockerImage;
    public readonly batchImage: CodeBuildDockerImage;

    // Pip layer
    public readonly boto3Layer: CodeBuildPipLayer;

    // Npm build — React app
    public readonly reactAppBuild: CodeBuildNpmBuild;

    constructor(scope: Construct, id: string, props: BuilderStackProps) {
        super(scope, id, {
            ...props,
            description: "Build infrastructure for Agentic Chatbot Accelerator (CodeBuild)",
        });

        // -----------------------------------------------------------------
        // Docker images — AgentCore variants
        // -----------------------------------------------------------------
        const agentCoreDir = path.join(__dirname, "../../src/agent-core");
        const dockerExcludes = [".git", "__pycache__", "*.pyc", "functions"];

        this.agentCoreImage = new CodeBuildDockerImage(this, "AgentCoreImage", {
            directory: agentCoreDir,
            file: "docker/Dockerfile",
            platform: "linux/arm64",
            excludes: dockerExcludes,
        });

        this.swarmImage = new CodeBuildDockerImage(this, "SwarmAgentCoreImage", {
            directory: agentCoreDir,
            file: "docker-swarm/Dockerfile",
            platform: "linux/arm64",
            excludes: dockerExcludes,
        });

        this.graphImage = new CodeBuildDockerImage(this, "GraphAgentCoreImage", {
            directory: agentCoreDir,
            file: "docker-graph/Dockerfile",
            platform: "linux/arm64",
            excludes: dockerExcludes,
        });

        this.agentsAsToolsImage = new CodeBuildDockerImage(
            this,
            "AgentsAsToolsAgentCoreImage",
            {
                directory: agentCoreDir,
                file: "docker-agents-as-tools/Dockerfile",
                platform: "linux/arm64",
                excludes: dockerExcludes,
            },
        );

        // Batch experiments image
        this.batchImage = new CodeBuildDockerImage(this, "BatchImage", {
            directory: path.join(__dirname, "../../src/experiments-batch/docker"),
            platform: "linux/arm64",
            excludes: [".git", "__pycache__", "*.pyc"],
        });

        // -----------------------------------------------------------------
        // Pip layer — boto3 latest
        // -----------------------------------------------------------------
        this.boto3Layer = new CodeBuildPipLayer(this, "Boto3Latest", {
            runtime: pythonRuntime,
            architecture: props.lambdaArchitecture,
            requirementsDir: path.join(__dirname, "../../src/shared/layers/boto3-latest"),
        });

        // -----------------------------------------------------------------
        // Npm build — React web app
        // -----------------------------------------------------------------
        this.reactAppBuild = new CodeBuildNpmBuild(this, "ReactAppBuild", {
            directory: path.join(__dirname, "../../src/user-interface/react-app"),
            excludes: ["node_modules", ".git", "dist", "*.pyc", "__pycache__"],
        });

        // -----------------------------------------------------------------
        // Outputs — consumed by AcaStack via cross-stack references
        // -----------------------------------------------------------------
        new cdk.CfnOutput(this, "AgentCoreImageUri", {
            value: this.agentCoreImage.imageUri,
            exportName: `${this.stackName}-AgentCoreImageUri`,
        });
        new cdk.CfnOutput(this, "SwarmImageUri", {
            value: this.swarmImage.imageUri,
            exportName: `${this.stackName}-SwarmImageUri`,
        });
        new cdk.CfnOutput(this, "GraphImageUri", {
            value: this.graphImage.imageUri,
            exportName: `${this.stackName}-GraphImageUri`,
        });
        new cdk.CfnOutput(this, "AgentsAsToolsImageUri", {
            value: this.agentsAsToolsImage.imageUri,
            exportName: `${this.stackName}-AgentsAsToolsImageUri`,
        });
        new cdk.CfnOutput(this, "BatchImageUri", {
            value: this.batchImage.imageUri,
            exportName: `${this.stackName}-BatchImageUri`,
        });
    }
}
