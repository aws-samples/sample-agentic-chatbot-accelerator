/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of the class `SharedAssetBundler`

Credits for this file go to the author of https://github.com/aws-samples/aws-genai-llm-chatbot
*/
import { AssetHashType, BundlingOutput, DockerImage, aws_s3_assets } from "aws-cdk-lib";
import { Code, S3Code } from "aws-cdk-lib/aws-lambda";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { md5hash } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

// Helper function to sanitize paths
function sanitizePath(inputPath: string): string {
    const sanitizedPath = path.normalize(inputPath);

    // Check if the sanitized path starts with the current working directory
    const cwd = process.cwd();
    if (!sanitizedPath.startsWith(cwd)) {
        throw new Error("Invalid path: Path traversal detected");
    }

    return sanitizedPath;
}

// Helper function to safely join and validate paths
function safePathJoin(basePath: string, ...segments: string[]): string {
    // Validate each segment doesn't contain path traversal patterns
    for (const segment of segments) {
        if (segment.includes("..") || segment.startsWith("/") || segment.startsWith("\\")) {
            throw new Error(`Invalid path segment: ${segment}`);
        }
    }

    // Segments are validated above for path traversal patterns - safe to join
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const joinedPath = path.join(basePath, ...segments);

    // Use path.resolve() for cross-platform consistent comparison
    // This ensures consistent path separators on Windows (/ vs \)
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const resolvedBase = path.resolve(basePath);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const resolvedPath = path.resolve(joinedPath);

    // Ensure the result is still within the base path
    // The + path.sep check prevents false positives (e.g., /base-extended matching /base)
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
        throw new Error("Invalid path: Path traversal detected after join");
    }

    return resolvedPath;
}

/**
 * Calculates a hash value from an array of file/directory paths.
 *
 * The hash is calculated by recursively traversing directories, hashing
 * the contents of files and directories, and combining the results.
 *
 * @param paths - An array of file/directory paths to hash
 * @returns A hashed string representing the contents
 */
function calculateHash(paths: string[]): string {
    return paths.reduce((mh, p) => {
        const sanitizedPath = sanitizePath(p);
        const dirs = fs.readdirSync(sanitizedPath);
        let hash = calculateHash(
            dirs
                .filter((d) => fs.statSync(safePathJoin(sanitizedPath, d)).isDirectory())
                .map((v) => safePathJoin(sanitizedPath, v)),
        );
        return md5hash(
            mh +
                dirs
                    .filter((d) => fs.statSync(safePathJoin(sanitizedPath, d)).isFile())
                    .reduce((h, f) => {
                        return md5hash(h + fs.readFileSync(safePathJoin(sanitizedPath, f)));
                    }, hash),
        );
    }, "");
}

/**
 * Bundles shared asset files with an asset.
 */
export class SharedAssetBundler extends Construct {
    private readonly sharedAssets: string[];
    private readonly WORKING_PATH = "/asset-input/";

    /**
     * Instantiate a new SharedAssetBundler. You then invoke `bundleWithAsset(pathToAsset)` to
     * bundle your asset code with the common code.
     *
     * For Lambda function handler assets, you can use `bundleWithLambdaAsset(pathToAsset)` as
     * a drop-in replacement for `lambda.Code.fromAsset()`
     *
     * @param scope
     * @param id
     * @param commonFolders : array of common folders to bundle with your asset code
     */
    constructor(scope: Construct, id: string, sharedAssets: string[]) {
        super(scope, id);
        this.sharedAssets = sharedAssets;
    }

    /**
     * Bundles the given asset path with shared assets.
     *
     * @param assetPath - Path to the asset file
     * @returns The bundled asset
     */
    bundleWithAsset(assetPath: string): Asset {
        console.log(`Bundling asset ${assetPath}`);
        const asset = new aws_s3_assets.Asset(this, md5hash(assetPath).slice(0, 6), {
            path: assetPath,
            bundling: {
                image: DockerImage.fromBuild(path.posix.join(__dirname, "./alpine-zip")),
                command: ["zip", "-r", path.posix.join("/asset-output", "asset.zip"), "."],
                volumes: this.sharedAssets.map((f) => ({
                    containerPath: path.posix.join(this.WORKING_PATH, path.basename(f)),
                    hostPath: f,
                })),
                workingDirectory: this.WORKING_PATH,
                outputType: BundlingOutput.ARCHIVED,
            },
            assetHash: calculateHash([assetPath, ...this.sharedAssets]),
            assetHashType: AssetHashType.CUSTOM,
        });
        return asset;
    }

    /**
     * Bundles the given asset path for Lambda and returns code.
     *
     * @param assetPath - Path to the asset file
     * @returns The bundled code
     */
    bundleWithLambdaAsset(assetPath: string): S3Code {
        const asset = this.bundleWithAsset(assetPath);
        return Code.fromBucket(asset.bucket, asset.s3ObjectKey);
    }
}
