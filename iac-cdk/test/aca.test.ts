// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig } from "../bin/config";
import { AcaStack } from "../lib/aca-stack";
import { BuilderStack } from "../lib/builder-stack";
import { modelsForRegion } from "../lib/shared/supported-models";

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
        deployRegion: "us-east-1",
    });
    acaStack.addDependency(builderStack);
    return Template.fromStack(acaStack);
}

// The deploy region the synth-slice assertions pin to. Must be a region seeded in
// SUPPORTED_MODELS, or T3's synth guard would abort. Kept in sync with synthTemplate().
const DEPLOY_REGION = "us-east-1";

// The UserInterface construct writes aws-exports.json via s3deploy.Source.jsonData(),
// which becomes a BucketDeployment asset: the JSON is emitted to a file under the synth
// output dir (cdk.out) rather than inlined in the CFN template. Synthesize the app to a
// throwaway outdir and return the raw text of that emitted asset so the test can inspect
// the exact bytes shipped to the browser.
function synthAwsExportsText(): string {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "aca-synth-"));
    const app = new cdk.App({ outdir });
    const config = getConfig();
    const builderStack = new BuilderStack(app, "test-aca-builder", {
        lambdaArchitecture: lambda.Architecture.X86_64,
    });
    const acaStack = new AcaStack(app, "test-aca", {
        config,
        builder: builderStack,
        deployRegion: DEPLOY_REGION,
    });
    acaStack.addDependency(builderStack);
    app.synth();

    // The jsonData asset is a single "aws-exports.json" at an asset root (the checked-in
    // React public/aws-exports.json also matches the name, so require both the file name
    // and the field we care about, and skip the "public/" static copy).
    const matches = findFiles(outdir, "aws-exports.json").filter(
        (f) =>
            !f.includes(`${path.sep}public${path.sep}`) &&
            fs.readFileSync(f, "utf8").includes("aws_bedrock_supported_models"),
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one emitted aws-exports.json asset, found ${matches.length}: ${matches.join(", ")}`,
        );
    }
    return fs.readFileSync(matches[0], "utf8");
}

// Recursively collect files whose base name matches `name` under `dir`.
function findFiles(dir: string, name: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...findFiles(full, name));
        } else if (entry.name === name) {
            out.push(full);
        }
    }
    return out;
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

describe("region-supported-models synth slice (T5)", () => {
    let exportsText: string;

    beforeAll(() => {
        exportsText = synthAwsExportsText();
    });

    test("aws_bedrock_supported_models equals modelsForRegion(deployRegion)", () => {
        // The emitted asset is not valid JSON wholesale (cdk.Aws.REGION etc. serialize to
        // <<marker:...>> tokens), but the model-id values are literal, so the slice object
        // parses in isolation. Extract just that object — its values contain no "}" so a
        // non-greedy match to the first closing brace captures the whole flat map.
        const match = exportsText.match(/"aws_bedrock_supported_models":(\{.*?\})/);
        expect(match).not.toBeNull();
        const slice = JSON.parse(match![1]);
        expect(slice).toEqual(modelsForRegion(DEPLOY_REGION));
    });

    test("emitted exports contain no [REGION-PREFIX] substitution token", () => {
        // T4/T6 invariant: ids are literal in IaC — no leftover substitution marker.
        expect(exportsText).not.toContain("[REGION-PREFIX]");
    });
});
