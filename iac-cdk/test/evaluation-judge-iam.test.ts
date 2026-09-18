// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// T4 — the Mantle grants on the evaluation-executor (LLM judge) role. EvaluationApi is
// synthesized on its own rather than through AcaStack: the construct takes every input it
// needs as a prop, so a full app synth (~6 min of Lambda bundling) would buy nothing, and
// getConfig() would read whichever bin/config.yaml the developer happens to have.

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";

import { EvaluationApi } from "../lib/api/evaluation-api";
import { CodeBuildPipBundle } from "../lib/codebuild-builder";
import { Shared } from "../lib/shared";
import { testConfig } from "./ui-gate-support";

const STACK_NAME = "judgeiam";

function synthEvaluationApi(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, STACK_NAME);

    const shared = new Shared(stack, "Shared", {
        lambdaArchitecture: lambda.Architecture.X86_64,
        boto3LayerBucket: s3.Bucket.fromBucketName(stack, "ArtifactBucket", "judge-iam-artifacts"),
        boto3LayerKey: "layers/boto3-latest/layer.zip",
    });

    const api = new appsync.GraphqlApi(stack, "Api", {
        name: `${STACK_NAME}-api`,
        definition: appsync.Definition.fromFile(
            path.join(__dirname, "../../src/api/schema/schema.graphql"),
        ),
    });

    const evaluatorsTable = new dynamodb.Table(stack, "EvaluatorsTable", {
        partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });
    const evaluatorRunsTable = new dynamodb.Table(stack, "EvaluatorRunsTable", {
        partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });

    new EvaluationApi(stack, "EvaluationApi", {
        shared,
        config: testConfig(),
        api,
        evaluatorsTable,
        evaluatorRunsTable,
        byUserIdIndex: "byUserId",
        byRunIdIndex: "byRunId",
        evaluationExecutorBundle: new CodeBuildPipBundle(stack, "EvalExecutorBundle", {
            directory: path.join(__dirname, "../../src/api/functions/evaluation-executor"),
            pipPackages: ["strands-agents-evals"],
            runtime: lambda.Runtime.PYTHON_3_14,
            architecture: lambda.Architecture.X86_64,
        }),
    });

    return Template.fromStack(stack);
}

// The judge Lambda, by function name — its logical id carries a construct-path hash.
// Throws rather than returning undefined so that a construct that stopped creating the
// function fails the suite instead of vacuously satisfying the absence assertions.
function judgeFunction(template: Template): Record<string, any> {
    const matches = Object.values(template.findResources("AWS::Lambda::Function")).filter(
        (resource) => resource.Properties?.FunctionName === `${STACK_NAME}-evaluation-executor`,
    );
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one evaluation-executor Lambda, found ${matches.length}`);
    }
    return matches[0];
}

// Identity policies attached to the judge Lambda's execution role, keyed by logical id.
function judgePolicies(template: Template): [string, Record<string, any>][] {
    const roleId = judgeFunction(template).Properties.Role["Fn::GetAtt"][0];
    return Object.entries(template.findResources("AWS::IAM::Policy")).filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId),
    );
}

function judgeStatements(template: Template): Record<string, any>[] {
    return judgePolicies(template).flatMap(
        ([, policy]) => policy.Properties?.PolicyDocument?.Statement ?? [],
    );
}

const actionsOf = (statement: Record<string, any>): string[] =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];

const statementsGranting = (statements: Record<string, any>[], action: string) =>
    statements.filter((statement) => actionsOf(statement).includes(action));

describe("Mantle IAM on the evaluation judge role (T4)", () => {
    let template: Template;

    beforeAll(() => {
        template = synthEvaluationApi();
    });

    test("the judge role is granted all three bedrock-mantle actions", () => {
        const granted = new Set(judgeStatements(template).flatMap(actionsOf));
        expect(granted).toContain("bedrock-mantle:CreateInference");
        expect(granted).toContain("bedrock-mantle:ListModels");
        expect(granted).toContain("bedrock-mantle:CallWithBearerToken");
    });

    test("Mantle inference is scoped to the stack's own account and region", () => {
        const statements = statementsGranting(
            judgeStatements(template),
            "bedrock-mantle:CreateInference",
        );
        expect(statements).toHaveLength(1);
        expect(statements[0].Effect).toEqual("Allow");

        const resource = JSON.stringify(statements[0].Resource);
        expect(resource).toContain("arn:aws:bedrock-mantle:");
        expect(resource).toContain(':project/*"');
        expect(resource).toContain('{"Ref":"AWS::Region"}');
        expect(resource).toContain('{"Ref":"AWS::AccountId"}');

        expect(statements[0].Condition).toEqual({
            StringEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } },
        });
    });

    test("ListModels rides on the account-scoped inference statement", () => {
        const statements = statementsGranting(
            judgeStatements(template),
            "bedrock-mantle:ListModels",
        );
        expect(statements).toHaveLength(1);
        expect(actionsOf(statements[0])).toContain("bedrock-mantle:CreateInference");
    });

    test('CallWithBearerToken is granted in its own statement scoped to "*"', () => {
        const statements = statementsGranting(
            judgeStatements(template),
            "bedrock-mantle:CallWithBearerToken",
        );
        expect(statements).toHaveLength(1);
        expect(actionsOf(statements[0])).toEqual(["bedrock-mantle:CallWithBearerToken"]);
        expect(statements[0].Resource).toEqual("*");
        expect(statements[0].Effect).toEqual("Allow");
    });

    test("no statement pairs the bearer-token action with a project-scoped resource", () => {
        for (const statement of judgeStatements(template)) {
            if (!actionsOf(statement).includes("bedrock-mantle:CallWithBearerToken")) continue;
            expect(JSON.stringify(statement.Resource)).not.toContain("project/*");
        }
    });

    test("the Mantle statements extend the judge role's existing policy", () => {
        // Contract row "No resource replacement": the grants are additions to the policy
        // document the role already had, not a second policy or a new role.
        const policies = judgePolicies(template);
        expect(policies).toHaveLength(1);

        const statements = policies[0][1].Properties.PolicyDocument.Statement;
        const actions = new Set(statements.flatMap(actionsOf));
        expect(actions).toContain("bedrock:Converse");
        expect(actions).toContain("bedrock-mantle:CreateInference");
        expect(actions).toContain("bedrock-mantle:CallWithBearerToken");
    });

    test("the IAM5 suppression on the judge policy justifies the bearer-token wildcard", () => {
        const suppressions = judgePolicies(template)[0][1].Metadata?.cdk_nag?.rules_to_suppress;
        const iam5 = (suppressions ?? []).filter((s: any) => s.id === "AwsSolutions-IAM5");
        expect(iam5).toHaveLength(1);
        expect(iam5[0].reason).toContain("CallWithBearerToken");
    });

    test("the judge's environment does not set bedrockAccessRoleArn", () => {
        // Keeping the cross-account Converse branch inert: base_factory reads the literal
        // camelCase key, so match case-insensitively to catch the SCREAMING_CASE spelling too.
        const variables = judgeFunction(template).Properties.Environment?.Variables ?? {};
        expect(
            Object.keys(variables).filter((key) => /bedrock.?access.?role.?arn/i.test(key)),
        ).toEqual([]);
    });
});
