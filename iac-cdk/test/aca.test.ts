// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { getConfig } from "../bin/config";
import { AcaStack } from "../lib/aca-stack";
import { BuilderStack } from "../lib/builder-stack";

// Synthesize the application stack once and reuse the template across the
// configuration-bundles migration assertions (T11). The stacks are wired the
// same way as bin/aca.ts so the template matches a real deploy.
function synthTemplate(): Template {
    const app = new cdk.App();
    const config = getConfig();
    const builderStack = new BuilderStack(app, "test-aca-builder", {
        lambdaArchitecture: lambda.Architecture.X86_64,
    });
    const acaStack = new AcaStack(app, "test-aca", {
        config,
        builder: builderStack,
    });
    acaStack.addDependency(builderStack);
    return Template.fromStack(acaStack);
}

describe("configuration-bundles migration (T11)", () => {
    let template: Template;

    beforeAll(() => {
        template = synthTemplate();
    });

    test("no runtime-config DynamoDB table remains", () => {
        // The per-agent runtime-config table + its LSI were removed; agent
        // config now lives in AgentCore configuration bundles (ADR-0001/0002).
        const tables = template.findResources("AWS::DynamoDB::Table");
        for (const [, resource] of Object.entries(tables)) {
            const name: string | undefined = resource.Properties?.TableName;
            expect(name).not.toMatch(/agentCoreRuntimeCfgTable/i);
            // The byAgentNameAndVersion LSI only existed on the removed table.
            const lsis = resource.Properties?.LocalSecondaryIndexes ?? [];
            for (const lsi of lsis) {
                expect(lsi.IndexName).not.toEqual("byAgentNameAndVersion");
            }
        }
    });

    test("summary table is still present", () => {
        // The summary table is retained and gained the bundle identity fields.
        template.hasResourceProperties("AWS::DynamoDB::Table", {
            TableName: Match.stringLikeRegexp("agentCoreSummaryTable"),
        });
    });

    test("no lambda carries the removed AGENT_CORE_RUNTIME_TABLE env var", () => {
        const fns = template.findResources("AWS::Lambda::Function");
        for (const [, resource] of Object.entries(fns)) {
            const vars = resource.Properties?.Environment?.Variables ?? {};
            expect(Object.keys(vars)).not.toContain("AGENT_CORE_RUNTIME_TABLE");
            expect(Object.keys(vars)).not.toContain("VERSIONS_TABLE_NAME");
            expect(Object.keys(vars)).not.toContain("AGENTS_TABLE_NAME");
        }
    });

    test("put-config-bundle lambda is present", () => {
        template.hasResourceProperties("AWS::Lambda::Function", {
            FunctionName: Match.stringLikeRegexp("putConfigBundle"),
        });
    });

    test("bundle IAM actions are wired with least-privilege scoping", () => {
        // Assert each bundle action appears in some IAM policy. Create/List are
        // not resource-scopable (Resource "*"); Update/Get/GetVersion/Delete are
        // scoped to configuration-bundle/*.
        const policies = template.findResources("AWS::IAM::Policy");
        const allStatements: any[] = [];
        for (const [, resource] of Object.entries(policies)) {
            const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
            allStatements.push(...statements);
        }

        const actionsInPolicies = new Set<string>();
        for (const stmt of allStatements) {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            for (const a of actions) {
                if (typeof a === "string") actionsInPolicies.add(a);
            }
        }

        expect(actionsInPolicies).toContain("bedrock-agentcore:CreateConfigurationBundle");
        expect(actionsInPolicies).toContain("bedrock-agentcore:UpdateConfigurationBundle");
        expect(actionsInPolicies).toContain("bedrock-agentcore:GetConfigurationBundleVersion");
        expect(actionsInPolicies).toContain("bedrock-agentcore:DeleteConfigurationBundle");

        // The resource-scopable bundle actions must target configuration-bundle
        // ARNs (not "*"). Verify GetConfigurationBundleVersion is so scoped.
        const scopedGetVersion = allStatements.some((stmt) => {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            if (!actions.includes("bedrock-agentcore:GetConfigurationBundleVersion")) {
                return false;
            }
            const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
            return resources.some((r: any) => JSON.stringify(r).includes("configuration-bundle/"));
        });
        expect(scopedGetVersion).toBe(true);
    });
});
