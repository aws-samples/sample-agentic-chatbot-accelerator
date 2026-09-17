// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// T2 — the judge bundle's pip dependencies. BuilderStack is synthesized with the same props
// bin/aca.ts passes, which is cheap: the stack holds only CodeBuild projects and buckets, so
// nothing here bundles a Lambda. The pip flags live in the project's inline BuildSpec — a JSON
// string inside an Fn::Join, so the assertions read the flattened command text.

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as fs from "fs";
import * as path from "path";

import { BuilderStack } from "../lib/builder-stack";
import { CodeBuildPipBundle } from "../lib/codebuild-builder";

const STACK_NAME = "bundledeps";
const BUNDLE_ID = "EvalExecutorBundle";
const EXECUTOR_DIR = path.join(__dirname, "../../src/api/functions/evaluation-executor");

// The Mantle SDKs FR6 requires in the bundle, and the evals SDK whose signature T3 depends on.
const EVALS_SDK = "strands-agents-evals";
const MANTLE_SDKS = ["openai", "anthropic", "aws-bedrock-token-generator"];

// bin/aca.ts wires BuilderStack with X86_64 and deployUserInterface from config; the flag is
// irrelevant here but required, and true is its default.
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
function synthBundle(pipPackages: string[]): { template: Template; artifactKey: string } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, STACK_NAME);
    const bundle = new CodeBuildPipBundle(stack, BUNDLE_ID, {
        directory: EXECUTOR_DIR,
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
        command = pipInstallCommand(synthBuilder(lambda.Architecture.X86_64));
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

    test("the wheels are resolved for aarch64", () => {
        // Acceptance: the build "log shows aarch64 wheels resolved" for the three SDKs. The log
        // half needs a deployed stack (T6); the platform tag pip is given is the synth-time half.
        expect(command).toContain("--platform manylinux2014_aarch64");
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

describe("changing the bundle's pipPackages replaces nothing (T2)", () => {
    const pinned = ["strands-agents-evals==0.1.8", "openai==2.48.0"];
    const other = ["strands-agents-evals==0.1.2"];

    test("the CodeBuild project keeps its name and logical id", () => {
        const before = synthBundle(other).template;
        const after = synthBundle(pinned).template;
        expect(Object.keys(after.findResources("AWS::CodeBuild::Project"))).toEqual(
            Object.keys(before.findResources("AWS::CodeBuild::Project")),
        );
        expect(bundleProject(after).Properties.Name).toEqual(bundleProject(before).Properties.Name);
    });

    test("the artifact key the judge Lambda reads is unchanged", () => {
        expect(synthBundle(pinned).artifactKey).toEqual(synthBundle(other).artifactKey);
    });

    test("the BuildSpec is the only property that differs", () => {
        const before = synthBundle(other).template.toJSON().Resources;
        const after = synthBundle(pinned).template.toJSON().Resources;
        const withoutBuildSpec = (resources: any) => {
            const copy = JSON.parse(JSON.stringify(resources));
            for (const resource of Object.values<any>(copy)) {
                if (resource.Type === "AWS::CodeBuild::Project") {
                    delete resource.Properties.Source.BuildSpec;
                }
            }
            return copy;
        };
        expect(withoutBuildSpec(after)).toEqual(withoutBuildSpec(before));
        expect(after).not.toEqual(before);
    });
});
