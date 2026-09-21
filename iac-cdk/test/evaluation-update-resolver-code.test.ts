// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// T1 — the behaviour of the two APPSYNC_JS resolver bodies themselves, which
// evaluation-notification.test.ts can only see as an asset hash. The resolvers are ESM with a
// bare `@aws-appsync/utils` import, and that package ships types only (`util` and `extensions`
// are empty objects at runtime), so each file is transpiled to CommonJS and executed against a
// stubbed module here. The last test ties the executed file back to the template, so the
// assertions above it are about deployed code and not an orphan file.

import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";

import { EvaluationApi } from "../lib/api/evaluation-api";
import { CodeBuildPipBundle } from "../lib/codebuild-builder";
import { Shared } from "../lib/shared";
import { testConfig } from "./ui-gate-support";

const RESOLVER_DIR = path.join(__dirname, "../../src/api/functions/resolvers/evaluation-update");
const PUBLISH_JS = path.join(RESOLVER_DIR, "publish.js");
const SUBSCRIBE_JS = path.join(RESOLVER_DIR, "subscribe.js");

interface Resolver {
    request(ctx: unknown): any;
    response(ctx: unknown): any;
}

// The resolvers run on APPSYNC_JS, where imports are resolved by the runtime rather than by
// node. Injecting `require` is what lets an unexpected import fail loudly instead of silently
// resolving out of iac-cdk/node_modules.
function loadResolver(file: string, modules: Record<string, unknown>): Resolver {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    });
    const module = { exports: {} as Record<string, unknown> };
    const requireStub = (id: string): unknown => {
        if (!(id in modules)) throw new Error(`${path.basename(file)} imported ${id}`);
        return modules[id];
    };
    new Function("exports", "require", "module", outputText)(module.exports, requireStub, module);
    return module.exports as unknown as Resolver;
}

// `ctx.args` is an alias of `ctx.arguments` in the APPSYNC_JS context, so both name the same
// object here: which alias a resolver reads is not part of the contract.
function context(args: Record<string, unknown>, result?: unknown): unknown {
    return { arguments: args, args, result, identity: {}, request: { headers: {} }, stash: {} };
}

const TRANSFORMED_FILTER = { transformedBy: "util.transform.toSubscriptionFilter" };

function appsyncUtils() {
    const toSubscriptionFilter: unknown[] = [];
    const setSubscriptionFilter: unknown[] = [];
    const modules = {
        "@aws-appsync/utils": {
            util: {
                transform: {
                    toSubscriptionFilter: (filter: unknown) => {
                        toSubscriptionFilter.push(filter);
                        return TRANSFORMED_FILTER;
                    },
                },
            },
            extensions: {
                setSubscriptionFilter: (filter: unknown) => setSubscriptionFilter.push(filter),
            },
        },
    };
    return { modules, toSubscriptionFilter, setSubscriptionFilter };
}

describe("publish.js (Mutation.publishEvaluationUpdate)", () => {
    const publish = () => loadResolver(PUBLISH_JS, {});

    test("relays evaluatorId, runId and status as the published payload", () => {
        const result = publish().request(
            context({ evaluatorId: "eval-7", runId: "run-42", status: "Completed" }),
        );

        expect(result.payload).toEqual({
            evaluatorId: "eval-7",
            runId: "run-42",
            status: "Completed",
        });
    });

    test("publishes nothing beyond the three arguments", () => {
        const result = publish().request(
            context({
                evaluatorId: "eval-7",
                runId: "run-42",
                status: "Failed",
                userId: "not-in-the-notification",
            }),
        );

        expect(Object.keys(result.payload).sort()).toEqual(["evaluatorId", "runId", "status"]);
        expect(result).toEqual({ payload: result.payload });
    });

    test("returns the resolver result unchanged", () => {
        const published = { evaluatorId: "eval-7", runId: "run-42", status: "Completed" };

        expect(publish().response(context({}, published))).toBe(published);
    });
});

describe("subscribe.js (Subscription.receiveEvaluationUpdate)", () => {
    test("registers the subscriber with no payload", () => {
        expect(loadResolver(SUBSCRIBE_JS, appsyncUtils().modules).request(context({}))).toEqual({
            payload: null,
        });
    });

    test("filters on evaluatorId equality", () => {
        const stub = appsyncUtils();

        loadResolver(SUBSCRIBE_JS, stub.modules).response(
            context({ evaluatorId: "eval-7", runId: "run-42" }),
        );

        expect(stub.toSubscriptionFilter).toEqual([{ evaluatorId: { eq: "eval-7" } }]);
    });

    // FR4 / design D3: clients filter runId themselves, so filtering it here would drop the
    // updates a surface watching another run of the same evaluator needs.
    test("does not filter on runId", () => {
        const stub = appsyncUtils();

        loadResolver(SUBSCRIBE_JS, stub.modules).response(
            context({ evaluatorId: "eval-7", runId: "run-42" }),
        );

        expect(JSON.stringify(stub.toSubscriptionFilter)).not.toContain("runId");
    });

    test("sets the transformed filter as the subscription filter", () => {
        const stub = appsyncUtils();

        const result = loadResolver(SUBSCRIBE_JS, stub.modules).response(
            context({ evaluatorId: "eval-7" }),
        );

        expect(stub.setSubscriptionFilter).toEqual([TRANSFORMED_FILTER]);
        expect(result).toBeNull();
    });
});

// EvaluationApi is synthesized on its own rather than through AcaStack, for the reasons
// evaluation-judge-iam.test.ts gives: every input is a prop, and getConfig() would read
// whichever bin/config.yaml the developer happens to have.
function synthAssembly(): { assemblyDir: string; template: any } {
    const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), "eval-resolver-")) });
    const stack = new cdk.Stack(app, "evalresolvercode");

    const shared = new Shared(stack, "Shared", {
        lambdaArchitecture: lambda.Architecture.X86_64,
        boto3LayerBucket: s3.Bucket.fromBucketName(stack, "ArtifactBucket", "evalresolver-assets"),
        boto3LayerKey: "layers/boto3-latest/layer.zip",
    });
    const api = new appsync.GraphqlApi(stack, "Api", {
        name: "evalresolvercode-api",
        definition: appsync.Definition.fromFile(
            path.join(__dirname, "../../src/api/schema/schema.graphql"),
        ),
    });

    new EvaluationApi(stack, "EvaluationApi", {
        shared,
        config: testConfig(),
        api,
        evaluatorsTable: new dynamodb.Table(stack, "EvaluatorsTable", {
            partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
        }),
        evaluatorRunsTable: new dynamodb.Table(stack, "EvaluatorRunsTable", {
            partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
        }),
        byUserIdIndex: "byUserId",
        byRunIdIndex: "byRunId",
        evaluationExecutorBundle: new CodeBuildPipBundle(stack, "EvalExecutorBundle", {
            directory: path.join(__dirname, "../../src/api/functions/evaluation-executor"),
            pipPackages: ["strands-agents-evals"],
            runtime: lambda.Runtime.PYTHON_3_14,
            architecture: lambda.Architecture.X86_64,
        }),
    });

    const assembly = app.synth();
    return {
        assemblyDir: assembly.directory,
        template: JSON.parse(
            fs.readFileSync(
                path.join(assembly.directory, "evalresolvercode.template.json"),
                "utf8",
            ),
        ),
    };
}

function stagedCode(assemblyDir: string, template: any, typeName: string, fieldName: string) {
    const resolvers = Object.values<any>(template.Resources).filter(
        (resource) =>
            resource.Type === "AWS::AppSync::Resolver" &&
            resource.Properties.TypeName === typeName &&
            resource.Properties.FieldName === fieldName,
    );
    expect(resolvers).toHaveLength(1);

    const location = JSON.stringify(resolvers[0].Properties.CodeS3Location);
    const asset = /([0-9a-f]{64})\.js/.exec(location);
    if (!asset) throw new Error(`No file asset in CodeS3Location ${location}`);
    // the interpolated segment is a 64-hex asset hash this test just matched out of the
    // template it synthesized itself — there is no external input anywhere in this file
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return fs.readFileSync(path.join(assemblyDir, `asset.${asset[1]}.js`), "utf8");
}

describe("the deployed resolver code is the code under test", () => {
    let synthesized: { assemblyDir: string; template: any };

    beforeAll(() => {
        synthesized = synthAssembly();
    });

    test.each([
        ["Mutation", "publishEvaluationUpdate", "publish.js"],
        ["Subscription", "receiveEvaluationUpdate", "subscribe.js"],
    ])("%s.%s deploys %s", (typeName, fieldName, file) => {
        expect(
            stagedCode(synthesized.assemblyDir, synthesized.template, typeName, fieldName),
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        ).toEqual(fs.readFileSync(path.join(RESOLVER_DIR, file), "utf8"));
    });
});
