// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// Shared fixtures for the deployUserInterface gate assertions, split across two files by
// cost: the BuilderStack half is cheap and runs in aca.test.ts, while every assertion that
// needs an AcaStack synth (~40 Lambda bundles, minutes each) lives in ui-gate.slow.test.ts,
// which the default `npm test` skips — see jest.config.js and `npm run test:slow`.

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";

import { AcaStack } from "../lib/aca-stack";
import { BuilderStack } from "../lib/builder-stack";
import { SystemConfig } from "../lib/shared/types";

// Must be a region seeded in SUPPORTED_MODELS, or assertRegionSupported aborts the synth.
export const DEPLOY_REGION = "us-east-1";

// Deliberately not getConfig(): that reads a developer's real bin/config.yaml when one
// exists, so a test built on it would pass or fail depending on whose machine it runs on.
// dataProcessingParameters is included because the CORS rule and the identity-pool upload
// grant hang off the data bucket — without one, their absence would prove nothing.
export function testConfig(deployUserInterface?: boolean): SystemConfig {
    return {
        prefix: "gatetest",
        enableGeoRestrictions: false,
        allowedGeoRegions: [],
        toolRegistry: [],
        mcpServerRegistry: [],
        ingestionLambdaProps: { timeoutInMinutes: 3, reservedConcurrency: 20 },
        dataProcessingParameters: {
            inputPrefix: "input",
            dataSourcePrefix: "data-source",
            processingPrefix: "processing",
            stagingMidfix: "staging",
            transcribeMidfix: "transcribe",
            languageCode: "en-US",
        },
        // Absent must stay absent: the parity assertions compare an omitted key against true.
        ...(deployUserInterface === undefined ? {} : { deployUserInterface }),
    };
}

// BuilderStack alone — no Lambda bundling, so this is the cheap half.
export function synthBuilder(deployUserInterface: boolean): Template {
    const app = new cdk.App();
    return Template.fromStack(
        new BuilderStack(app, "gate-builder", {
            lambdaArchitecture: lambda.Architecture.X86_64,
            deployUserInterface,
        }),
    );
}

// Both stacks, wired exactly as bin/aca.ts wires them. ReactAppBuild lives in the builder
// stack, everything else in the app stack — hence both templates.
export function synthBoth(config: SystemConfig): { builder: Template; aca: Template } {
    const app = new cdk.App();
    const builderStack = new BuilderStack(app, "gate-builder", {
        lambdaArchitecture: lambda.Architecture.X86_64,
        deployUserInterface: config.deployUserInterface ?? true,
    });
    const acaStack = new AcaStack(app, "gate-aca", {
        config,
        builder: builderStack,
        deployRegion: DEPLOY_REGION,
    });
    acaStack.addDependency(builderStack);
    return { builder: Template.fromStack(builderStack), aca: Template.fromStack(acaStack) };
}

// Every IAM action granted to the Cognito identity pool's authenticated role. The
// unauthenticated role is excluded by matching the amr condition value exactly —
// "unauthenticated" contains "authenticated" as a substring.
export function authenticatedRoleActions(template: Template): Set<string> {
    const roles = template.findResources("AWS::IAM::Role");
    const roleIds = Object.entries(roles)
        .filter(([, role]) => {
            const statements = role.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
            return statements.some((statement: any) =>
                Object.values(statement.Condition ?? {}).some((condition: any) =>
                    Object.values(condition as object).some((value) => value === "authenticated"),
                ),
            );
        })
        .map(([id]) => id);

    const actions = new Set<string>();
    const collect = (statements: any[]) => {
        for (const statement of statements) {
            const list = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
            for (const action of list) if (typeof action === "string") actions.add(action);
        }
    };

    for (const [, policy] of Object.entries(template.findResources("AWS::IAM::Policy"))) {
        const attachedTo = JSON.stringify(policy.Properties?.Roles ?? []);
        if (!roleIds.some((id) => attachedTo.includes(id))) continue;
        collect(policy.Properties?.PolicyDocument?.Statement ?? []);
    }
    for (const id of roleIds) {
        for (const inline of roles[id].Properties?.Policies ?? []) {
            collect(inline.PolicyDocument?.Statement ?? []);
        }
    }
    return actions;
}

export const bucketsIn = (template: Template) =>
    Object.keys(template.findResources("AWS::S3::Bucket")).length;

export const bucketDeployments = (template: Template) =>
    Object.entries(template.toJSON().Resources ?? {}).filter(([, resource]: [string, any]) =>
        resource.Type.startsWith("Custom::CDKBucketDeployment"),
    );

export const bucketsWithCors = (template: Template) =>
    Object.entries(template.findResources("AWS::S3::Bucket")).filter(
        ([, bucket]) => bucket.Properties?.CorsConfiguration !== undefined,
    );

export const reactAppBuildResources = (template: Template) =>
    Object.keys(template.toJSON().Resources ?? {}).filter((id) => id.startsWith("ReactAppBuild"));
