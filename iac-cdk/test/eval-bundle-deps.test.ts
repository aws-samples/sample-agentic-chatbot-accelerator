// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// T2 — the judge bundle's pip dependencies. BuilderStack is synthesized with the same props
// bin/aca.ts passes, which is cheap: the stack holds only CodeBuild projects and buckets, so
// nothing here bundles a Lambda. The pip flags live in the project's inline BuildSpec — a JSON
// string inside an Fn::Join, so the assertions read the flattened command text. The second
// describe covers the other half: those flags only take effect if editing them moves the source
// asset hash, which is what build.sh diffs and what the judge Lambda's code key is built from.

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { BuilderStack } from "../lib/builder-stack";
import { CodeBuildPipBundle } from "../lib/codebuild-builder";

const STACK_NAME = "bundledeps";
const BUNDLE_ID = "EvalExecutorBundle";
const EXECUTOR_DIR = path.join(__dirname, "../../src/api/functions/evaluation-executor");

// The Mantle SDKs FR6 requires in the bundle, and the evals SDK whose signature T3 depends on.
const EVALS_SDK = "strands-agents-evals";
const MANTLE_SDKS = ["openai", "anthropic", "aws-bedrock-token-generator"];

// The architecture bin/aca.ts wires into BuilderStack, read from that source rather than
// duplicated here: the platform tag assertion below has to follow the deploy, not a literal.
function deployArchitecture(): lambda.Architecture {
    const source = fs.readFileSync(path.join(__dirname, "../bin/aca.ts"), "utf8");
    const match = source.match(
        /new BuilderStack\([^)]*?lambdaArchitecture:\s*lambda\.Architecture\.(\w+)/,
    );
    if (match === null) {
        throw new Error("bin/aca.ts does not wire a lambdaArchitecture into BuilderStack");
    }
    const architecture: Record<string, lambda.Architecture> = {
        X86_64: lambda.Architecture.X86_64,
        ARM_64: lambda.Architecture.ARM_64,
    };
    if (!(match[1] in architecture)) {
        throw new Error(`bin/aca.ts wires an unhandled architecture: ${match[1]}`);
    }
    return architecture[match[1]];
}

// PEP 599 platform tags: the wheels pip may resolve for a given Lambda architecture.
function expectedPlatformTag(architecture: lambda.Architecture): string {
    return architecture === lambda.Architecture.ARM_64
        ? "manylinux2014_aarch64"
        : "manylinux2014_x86_64";
}

// deployUserInterface is irrelevant to the bundle but required, and true is its default.
function synthBuilder(architecture: lambda.Architecture): Template {
    const app = new cdk.App();
    return Template.fromStack(
        new BuilderStack(app, STACK_NAME, {
            lambdaArchitecture: architecture,
            deployUserInterface: true,
        }),
    );
}

// A stack holding nothing but the bundle, so pipPackages can be varied — BuilderStack hardcodes
// them. Wired exactly as BuilderStack wires it, id included, so logical ids match.
function synthBundle(
    pipPackages: string[],
    directory: string = EXECUTOR_DIR,
): { template: Template; artifactKey: string } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, STACK_NAME);
    const bundle = new CodeBuildPipBundle(stack, BUNDLE_ID, {
        directory,
        pipPackages,
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.X86_64,
    });
    return { template: Template.fromStack(stack), artifactKey: bundle.artifactKey };
}

// The bundle's CodeBuild project, by project name. Throws rather than returning undefined so a
// stack that stopped creating it fails loudly instead of satisfying the assertions vacuously.
function bundleProject(template: Template): Record<string, any> {
    const matches = Object.values(template.findResources("AWS::CodeBuild::Project")).filter(
        (resource) => resource.Properties?.Name === `${STACK_NAME}-${BUNDLE_ID}-builder`,
    );
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${BUNDLE_ID} project, found ${matches.length}`);
    }
    return matches[0];
}

// The S3 source path build.sh reads back as `projects[0].source.location`.
function sourceLocation(template: Template): string {
    const location = bundleProject(template).Properties?.Source?.Location;
    if (location === undefined) {
        throw new Error(`${BUNDLE_ID} project carries no S3 source location`);
    }
    return JSON.stringify(location);
}

function buildSpecText(project: Record<string, any>): string {
    const spec = project.Properties?.Source?.BuildSpec;
    if (typeof spec === "string") return spec;
    const parts = spec?.["Fn::Join"]?.[1];
    if (!Array.isArray(parts)) {
        throw new Error(`${BUNDLE_ID} project carries no inline BuildSpec`);
    }
    return parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("");
}

// The dependency install command, anchored on its target dir so the install phase's
// `python3 -m pip install --upgrade pip` cannot match instead.
function pipInstallCommand(template: Template): string {
    const match = buildSpecText(bundleProject(template)).match(
        /"(pip install [^"]*-t \/tmp\/package[^"]*)"/,
    );
    if (match === null) {
        throw new Error(`${BUNDLE_ID} BuildSpec has no pip install command`);
    }
    return match[1];
}

// The requirement specifiers handed to pip, i.e. everything before the first flag.
function requestedPackages(command: string): string[] {
    return command
        .replace(/^pip install /, "")
        .split(" -t /tmp/package")[0]
        .split(/\s+/)
        .filter((token) => token.length > 0);
}

function specifierFor(specifiers: string[], name: string): string | undefined {
    return specifiers.find(
        (spec) => spec.startsWith(name) && /^(\[|[<>=!~]|$)/.test(spec.slice(name.length)),
    );
}

// The version of an exact `name==version` pin, or undefined for any looser specifier.
function exactPin(specifiers: string[], name: string): string | undefined {
    const match = specifierFor(specifiers, name)?.match(/^(.+)==([0-9][^=<>!~,\s]*)$/);
    return match !== null && match !== undefined && match[1] === name ? match[2] : undefined;
}

function parseVersion(version: string): number[] {
    return version.split(".").map((part) => Number.parseInt(part, 10));
}

// The lower bound the repo's own dev environment declares for a package.
function devGroupFloor(name: string): number[] {
    const pyproject = fs.readFileSync(path.join(__dirname, "../../pyproject.toml"), "utf8");
    const match = pyproject.match(new RegExp(`"${name}>=([0-9.]+)"`));
    if (match === null) {
        throw new Error(`No ${name} lower bound in the repo's pyproject.toml`);
    }
    return parseVersion(match[1]);
}

function isAtLeast(version: number[], floor: number[]): boolean {
    for (let i = 0; i < Math.max(version.length, floor.length); i++) {
        const left = version[i] ?? 0;
        const right = floor[i] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

describe("the judge bundle's pip dependencies (T2)", () => {
    let packages: string[];
    let command: string;

    beforeAll(() => {
        command = pipInstallCommand(synthBuilder(deployArchitecture()));
        packages = requestedPackages(command);
    });

    test("the builder stack installs the judge's dependencies into the bundle", () => {
        expect(packages.length).toBeGreaterThan(0);
        expect(command).toContain("-t /tmp/package");
    });

    test("strands-agents-evals carries an exact == pin", () => {
        expect(exactPin(packages, EVALS_SDK)).toMatch(/^[0-9]+(\.[0-9]+)*$/);
    });

    test("the evals pin is at least the version the repo develops against", () => {
        const pinned = exactPin(packages, EVALS_SDK);
        expect(pinned).toBeDefined();
        expect(isAtLeast(parseVersion(pinned!), devGroupFloor(EVALS_SDK))).toBe(true);
    });

    test("all three Mantle SDKs are installed", () => {
        for (const sdk of MANTLE_SDKS) {
            expect(specifierFor(packages, sdk)).toBeDefined();
        }
    });

    test("every Mantle SDK is pinned to an exact version", () => {
        for (const sdk of MANTLE_SDKS) {
            expect(exactPin(packages, sdk)).toMatch(/^[0-9]+(\.[0-9]+)*$/);
        }
    });

    test("strands-agents stays transitive — no direct specifier, no extras", () => {
        expect(specifierFor(packages, "strands-agents")).toBeUndefined();
        expect(command).not.toContain("strands-agents[");
    });

    test("pip is forced to prebuilt wheels for the Lambda runtime, never a source build", () => {
        expect(command).toContain("--only-binary=:all:");
        expect(command).toContain("--python-version 3.14");
        expect(command).toContain("--implementation cp");
    });

    test("the wheel platform tag follows the architecture the deploy wires", () => {
        // Acceptance names aarch64, which is the Terraform tree's default; the CDK tree deploys
        // X86_64. Both sides read bin/aca.ts, so flipping it re-targets this instead of lying.
        expect(command).toContain(`--platform ${expectedPlatformTag(deployArchitecture())}`);
    });

    test("the pin assertions are not vacuous — an unpinned list fails them", () => {
        const unpinned = requestedPackages(
            pipInstallCommand(synthBundle([EVALS_SDK, ...MANTLE_SDKS]).template),
        );
        expect(exactPin(unpinned, EVALS_SDK)).toBeUndefined();
        for (const sdk of MANTLE_SDKS) {
            expect(specifierFor(unpinned, sdk)).toEqual(sdk);
            expect(exactPin(unpinned, sdk)).toBeUndefined();
        }
    });
});

describe("a pins-only edit reaches the deployed bundle (T2)", () => {
    const pinned = ["strands-agents-evals==0.1.8", "openai==2.48.0"];
    const other = ["strands-agents-evals==0.1.2", "openai==2.48.0"];

    test("the CodeBuild project keeps its name and logical id", () => {
        const before = synthBundle(other).template;
        const after = synthBundle(pinned).template;
        expect(Object.keys(after.findResources("AWS::CodeBuild::Project"))).toEqual(
            Object.keys(before.findResources("AWS::CodeBuild::Project")),
        );
        expect(bundleProject(after).Properties.Name).toEqual(bundleProject(before).Properties.Name);
    });

    test("the source location build.sh diffs moves with the pins", () => {
        // build.sh skips a project whose source.location matches its last successful build, and
        // the pins only ever reach the build through the inline BuildSpec — so unless the pins
        // feed the source asset hash, a pins-only bump deploys the previously built wheels.
        expect(sourceLocation(synthBundle(pinned).template)).not.toEqual(
            sourceLocation(synthBundle(other).template),
        );
        expect(sourceLocation(synthBundle(pinned).template)).toEqual(
            sourceLocation(synthBundle(pinned).template),
        );
    });

    test("the artifact key the judge Lambda reads moves with the pins", () => {
        // Code.fromBucket pins no object version, so an unchanged key means CloudFormation
        // leaves the function pointing at the zip it already deployed.
        expect(synthBundle(pinned).artifactKey).not.toEqual(synthBundle(other).artifactKey);
        expect(synthBundle(pinned).artifactKey).toEqual(synthBundle(pinned).artifactKey);
    });

    test("the source hash still tracks the directory contents, not just the pins", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pip-bundle-source-"));
        try {
            const handler = path.join(directory, "index.py");
            fs.writeFileSync(handler, "def handler(event, context):\n    return 1\n");
            const before = synthBundle(pinned, directory).artifactKey;
            fs.writeFileSync(handler, "def handler(event, context):\n    return 2\n");
            expect(synthBundle(pinned, directory).artifactKey).not.toEqual(before);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("the BuildSpec and the source asset reference are all that differ", () => {
        const before = synthBundle(other).template.toJSON().Resources;
        const after = synthBundle(pinned).template.toJSON().Resources;
        // The asset key reaches the project's Source and the GetObject grant CDK derives from it.
        const normalized = (resources: any) => {
            const copy = JSON.parse(JSON.stringify(resources));
            for (const resource of Object.values<any>(copy)) {
                if (resource.Type === "AWS::CodeBuild::Project") {
                    delete resource.Properties.Source.BuildSpec;
                }
            }
            return JSON.parse(JSON.stringify(copy).replace(/[0-9a-f]{64}/g, "<asset-hash>"));
        };
        expect(JSON.stringify(after)).toMatch(/[0-9a-f]{64}/);
        expect(normalized(after)).toEqual(normalized(before));
        expect(after).not.toEqual(before);
    });
});
