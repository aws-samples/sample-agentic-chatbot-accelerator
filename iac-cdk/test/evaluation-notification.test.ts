// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// T1 — the evaluation notification wiring: a NONE data source plus the
// publishEvaluationUpdate / receiveEvaluationUpdate resolver pair. EvaluationApi is
// synthesized on its own rather than through AcaStack, for the same reasons as
// evaluation-judge-iam.test.ts: the construct takes every input as a prop, so a full app
// synth (~6 min of Lambda bundling) would buy nothing, and getConfig() would read whichever
// bin/config.yaml the developer happens to have.

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

const STACK_NAME = "evalnotify";

// The construct is created only when `withEvaluationApi` is true, which stands in for the
// `evaluatorConfig` gate in aca-stack.ts: everything else in the stack is identical.
function synthStack(withEvaluationApi: boolean): { template: Template; operations: string[] } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, STACK_NAME);

    const shared = new Shared(stack, "Shared", {
        lambdaArchitecture: lambda.Architecture.X86_64,
        boto3LayerBucket: s3.Bucket.fromBucketName(stack, "ArtifactBucket", "evalnotify-artifacts"),
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

    const operations = withEvaluationApi
        ? new EvaluationApi(stack, "EvaluationApi", {
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
          }).operations
        : [];

    return { template: Template.fromStack(stack), operations };
}

type Resource = Record<string, any>;

// DataSourceName is a plain string in the template (AppSync data sources are referenced by
// name, not by Ref), so resolvers join to data sources through Properties.Name.
function dataSourceTypeByName(template: Template): Record<string, string> {
    return Object.fromEntries(
        Object.values(template.findResources("AWS::AppSync::DataSource")).map((ds: Resource) => [
            ds.Properties.Name,
            ds.Properties.Type,
        ]),
    );
}

function resolverEntryFor(
    template: Template,
    typeName: string,
    fieldName: string,
): [string, Resource] {
    const matches = Object.entries(template.findResources("AWS::AppSync::Resolver")).filter(
        ([, resolver]) =>
            (resolver as Resource).Properties?.TypeName === typeName &&
            (resolver as Resource).Properties?.FieldName === fieldName,
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one ${typeName}.${fieldName} resolver, got ${matches.length}`,
        );
    }
    return matches[0] as [string, Resource];
}

function resolverFor(template: Template, typeName: string, fieldName: string): Resource {
    return resolverEntryFor(template, typeName, fieldName)[1];
}

function executorFunction(template: Template): Resource {
    const matches = Object.values(template.findResources("AWS::Lambda::Function")).filter(
        (resource: Resource) =>
            resource.Properties?.FunctionName === `${STACK_NAME}-evaluation-executor`,
    );
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one evaluation-executor Lambda, found ${matches.length}`);
    }
    return matches[0];
}

function executorStatements(template: Template): Resource[] {
    const roleId = executorFunction(template).Properties.Role["Fn::GetAtt"][0];
    return Object.values(template.findResources("AWS::IAM::Policy"))
        .filter((policy: Resource) =>
            JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId),
        )
        .flatMap((policy: Resource) => policy.Properties?.PolicyDocument?.Statement ?? []);
}

const actionsOf = (statement: Resource): string[] =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];

// A CDK logical id is the construct path plus an 8-hex hash of that same path; the hashes are
// dropped here because they are redundant with the readable half (and read as typos).
const withoutHash = (logicalId: string): string => logicalId.replace(/[0-9A-F]{8}$/, "");

// The eleven Lambda-backed resolvers, by logical id. evaluation-api.ts warns that its
// resolverId strings preserve CloudFormation logical ids, and a logical id encodes the
// construct path — so renaming or re-parenting one replaces a live resolver.
const EXISTING_RESOLVER_LOGICAL_IDS = [
    "ApiListEvaluatorsResolver",
    "ApiGetEvaluatorResolver",
    "ApiListEvaluatorRunsResolver",
    "ApiGetEvaluatorRunResolver",
    "ApiGetEvaluatorTestCasesResolver",
    "ApiCreateEvaluatorResolver",
    "ApiUpdateEvaluatorResolver",
    "ApiDeleteEvaluatorResolver",
    "ApiStartEvaluatorRunResolver",
    "ApiRunEvaluationResolver",
    "ApiDeleteEvaluatorRunResolver",
];

// Mutation.publishEvaluationUpdate was already resolvable before this story: HttpApiBackend's
// schema-driven loop created a proxy resolver as `<api>/publishEvaluationUpdate-resolver`. The NONE
// resolver reuses that scope and id so CloudFormation updates DataSourceName in place. Re-scoping
// or renaming it makes the deploy a create-then-delete, which AppSync rejects — one resolver per
// Type.Field.
const PUBLISH_RESOLVER_LOGICAL_ID = "ApipublishEvaluationUpdateresolver";

const EXPECTED_EXECUTOR_ENV_KEYS = [
    "ACCOUNT_ID",
    "APPSYNC_API_ENDPOINT",
    "EVALUATIONS_BUCKET",
    "EVALUATIONS_TABLE",
    "EVALUATOR_RUNS_TABLE",
    "LOG_LEVEL",
    "POWERTOOLS_DEV",
    "POWERTOOLS_LOGGER_LOG_EVENT",
    "POWERTOOLS_SERVICE_NAME",
];

describe("evaluation notification resolvers (T1)", () => {
    let template: Template;
    let operations: string[];

    beforeAll(() => {
        ({ template, operations } = synthStack(true));
    });

    test.each([
        ["Mutation", "publishEvaluationUpdate"],
        ["Subscription", "receiveEvaluationUpdate"],
    ])("%s.%s is a JS resolver on a NONE data source", (typeName, fieldName) => {
        const properties = resolverFor(template, typeName, fieldName).Properties;

        expect(dataSourceTypeByName(template)[properties.DataSourceName]).toEqual("NONE");
        expect(properties.Runtime).toEqual({ Name: "APPSYNC_JS", RuntimeVersion: "1.0.0" });
        expect(properties.CodeS3Location).toBeDefined();
    });

    test("the two resolvers ship different code assets", () => {
        const publish = resolverFor(template, "Mutation", "publishEvaluationUpdate");
        const subscribe = resolverFor(template, "Subscription", "receiveEvaluationUpdate");
        expect(JSON.stringify(publish.Properties.CodeS3Location)).not.toEqual(
            JSON.stringify(subscribe.Properties.CodeS3Location),
        );
    });

    test("the NONE data source is created once and reused by both resolvers", () => {
        const noneDataSources = Object.values(
            template.findResources("AWS::AppSync::DataSource"),
        ).filter((ds: Resource) => ds.Properties.Type === "NONE");
        expect(noneDataSources).toHaveLength(1);

        const publish = resolverFor(template, "Mutation", "publishEvaluationUpdate");
        const subscribe = resolverFor(template, "Subscription", "receiveEvaluationUpdate");
        expect(publish.Properties.DataSourceName).toEqual(noneDataSources[0].Properties.Name);
        expect(subscribe.Properties.DataSourceName).toEqual(noneDataSources[0].Properties.Name);
    });

    test("both fields are registered in operations, so HttpApiBackend excludes them", () => {
        expect(operations).toContain("publishEvaluationUpdate");
        expect(operations).toContain("receiveEvaluationUpdate");
    });

    test("the eleven Lambda-backed resolvers keep their logical ids", () => {
        const lambdaBacked = Object.entries(template.findResources("AWS::AppSync::Resolver"))
            .filter(
                ([, resolver]) =>
                    dataSourceTypeByName(template)[
                        (resolver as Resource).Properties.DataSourceName
                    ] === "AWS_LAMBDA",
            )
            .map(([logicalId]) => withoutHash(logicalId));

        expect(lambdaBacked.sort()).toEqual([...EXISTING_RESOLVER_LOGICAL_IDS].sort());
    });

    test("publishEvaluationUpdate keeps the logical id its proxy resolver had", () => {
        const [logicalId] = resolverEntryFor(template, "Mutation", "publishEvaluationUpdate");
        expect(withoutHash(logicalId)).toEqual(PUBLISH_RESOLVER_LOGICAL_ID);
    });

    test("the executor role gained no permission beyond the appsync:GraphQL it already had", () => {
        const statements = executorStatements(template);
        const appsyncStatements = statements.filter((statement) =>
            actionsOf(statement).some((action) => String(action).startsWith("appsync:")),
        );
        expect(appsyncStatements).toHaveLength(1);
        expect(actionsOf(appsyncStatements[0])).toEqual(["appsync:GraphQL"]);
    });

    test("the executor's environment gained no variable", () => {
        const variables = executorFunction(template).Properties.Environment?.Variables ?? {};
        expect(Object.keys(variables).sort()).toEqual(EXPECTED_EXECUTOR_ENV_KEYS);
    });

    test("without EvaluationApi neither resolver nor NONE data source exists", () => {
        const { template: gated } = synthStack(false);

        const fields = Object.values(gated.findResources("AWS::AppSync::Resolver")).map(
            (resolver: Resource) => resolver.Properties.FieldName,
        );
        expect(fields).not.toContain("publishEvaluationUpdate");
        expect(fields).not.toContain("receiveEvaluationUpdate");
        gated.resourceCountIs("AWS::AppSync::DataSource", 0);
    });
});
