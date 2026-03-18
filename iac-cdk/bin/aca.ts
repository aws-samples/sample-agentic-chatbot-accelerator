#!/usr/bin/env node

// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AwsSolutionsChecks } from "cdk-nag";
import { IConstruct } from "constructs";
import "source-map-support/register";
import { AcaStack } from "../lib/aca-stack";
import { getConfig } from "./config";

/**
 * CDK Aspect that upgrades any Lambda function using an outdated Node.js runtime
 * to the latest supported version (nodejs24.x). This ensures CDK framework-managed
 * Lambdas (e.g., AwsCustomResource singleton) use a current runtime.
 * Must be registered before CDK-nag so runtime is updated before validation.
 */
class LambdaNodejsRuntimeUpgrader implements cdk.IAspect {
    visit(node: IConstruct): void {
        if (node instanceof cdk.CfnResource && node.cfnResourceType === "AWS::Lambda::Function") {
            const cfnFunc = node as lambda.CfnFunction;
            const runtime = cfnFunc.runtime;
            if (
                typeof runtime === "string" &&
                runtime.startsWith("nodejs") &&
                runtime !== "nodejs24.x"
            ) {
                cfnFunc.runtime = "nodejs24.x";
            }
        }
    }
}

const app = new cdk.App();
const config = getConfig();

// in principle if the prefix is `dev` the stack should be called dev-aca
// however, we, treat `dev` as default config. This might be changed if you are starting from scratch in a new account
const baseName = "aca";
const stackName = config.prefix == "" ? baseName : `${config.prefix}-${baseName}`;
const stack = new AcaStack(app, stackName, {
    config: config,
});
cdk.Tags.of(stack).add("Stack", baseName.toLowerCase());
cdk.Tags.of(stack).add("Team", "genaiic");
if (config.prefix) {
    cdk.Tags.of(stack).add("Environment", config.prefix.toLowerCase());
}
// Register runtime upgrader BEFORE CDK-nag so Lambda runtimes are updated before validation
cdk.Aspects.of(app).add(new LambdaNodejsRuntimeUpgrader());
cdk.Aspects.of(app).add(new AwsSolutionsChecks());
