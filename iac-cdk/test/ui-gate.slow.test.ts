// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// Excluded from `npm test` (jest.config.js ignores *.slow.test.ts); run with
// `npm run test:slow`. Three AcaStack synths, each re-bundling every Lambda, put this file
// at ~15 minutes. The cheap half of the same gate runs by default in aca.test.ts.

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";

import { AcaStack } from "../lib/aca-stack";
import { BuilderStack } from "../lib/builder-stack";
import {
    DEPLOY_REGION,
    authenticatedRoleActions,
    bucketDeployments,
    bucketsIn,
    bucketsWithCors,
    synthBoth,
    testConfig,
} from "./ui-gate-support";

describe("deployUserInterface gate — AcaStack (T4)", () => {
    let on: { builder: Template; aca: Template };
    let off: { builder: Template; aca: Template };
    let absent: { builder: Template; aca: Template };

    beforeAll(() => {
        on = synthBoth(testConfig(true));
        off = synthBoth(testConfig(false));
        absent = synthBoth(testConfig(undefined));
    }, 900_000);

    test("flag on: every gated resource is present, so the off-assertions have teeth", () => {
        on.aca.resourceCountIs("AWS::CloudFront::Distribution", 1);
        expect(bucketDeployments(on.aca)).toHaveLength(1);
        expect(bucketsWithCors(on.aca)).toHaveLength(1);
        expect(authenticatedRoleActions(on.aca)).toContain("s3:PutObject");
    });

    describe("flag off — the removal set (FR1, FR3)", () => {
        test("no CloudFront distribution", () => {
            off.aca.resourceCountIs("AWS::CloudFront::Distribution", 0);
        });

        test("no BucketDeployment, so no aws-exports.json is shipped", () => {
            // aws-exports.json is a BucketDeployment asset written to cdk.out rather than
            // a template resource, so the deployment's absence is what proves it is gone.
            expect(bucketDeployments(off.aca)).toHaveLength(0);
        });

        test("no bucket carries a CORS rule", () => {
            expect(bucketsWithCors(off.aca)).toHaveLength(0);
        });

        test("the authenticated role gets no S3 upload grant", () => {
            const actions = authenticatedRoleActions(off.aca);
            expect(actions).not.toContain("s3:PutObject");
            expect(actions).not.toContain("s3:DeleteObject");
            // The unrelated AgentCore grant on the same role is untouched.
            expect(actions).toContain("bedrock-agentcore:InvokeAgentRuntime");
        });

        test("the website and logs buckets are gone", () => {
            // Counting beats naming: these three have generated logical ids, but the
            // difference against the UI-on template is stable across CDK versions.
            expect(bucketsIn(off.aca)).toBe(bucketsIn(on.aca) - 3);
        });
    });

    describe("an absent key means on (FR2)", () => {
        test("app stack template is identical to an explicit true", () => {
            expect(absent.aca.toJSON()).toEqual(on.aca.toJSON());
        });

        test("builder stack template is identical to an explicit true", () => {
            expect(absent.builder.toJSON()).toEqual(on.builder.toJSON());
        });
    });

    test("UI on against a builder stack built with it off throws, not TypeError", () => {
        const app = new cdk.App();
        const builderStack = new BuilderStack(app, "mismatch-builder", {
            lambdaArchitecture: lambda.Architecture.X86_64,
            deployUserInterface: false,
        });
        expect(
            () =>
                new AcaStack(app, "mismatch-aca", {
                    config: testConfig(true),
                    builder: builderStack,
                    deployRegion: DEPLOY_REGION,
                }),
        ).toThrow(/reactAppBuild/);
    }, 300_000);
});
