// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { generatePrefix } from "../shared/utils";

/**
 * Dedicated S3 bucket for storing Agent Skills (markdown instruction packages).
 *
 * Skills are stored as markdown files with YAML frontmatter following the
 * Agent Skills specification (https://agentskills.io/specification).
 *
 * Phase 1 layout: skills/{name}.md
 * Phase 2 layout: skills/{name}/SKILL.md + scripts/ + references/ + assets/
 */
export class SkillsBucket extends Construct {
    public readonly bucket: s3.Bucket;

    constructor(scope: Construct, id: string) {
        super(scope, id);

        const prefix = generatePrefix(this);
        const stack = cdk.Stack.of(this);

        const removalCondition = ["prod-", "prd-", "live-"].some((p) =>
            prefix.toLowerCase().startsWith(p.toLowerCase()),
        )
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY;
        const autoDeleteObjects = removalCondition === cdk.RemovalPolicy.DESTROY;

        // Access logging bucket
        const loggingBucket = new s3.Bucket(this, "SkillsLoggingBucket", {
            bucketName: `${prefix}-logging-skills-${stack.region}-${stack.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
        });

        this.bucket = new s3.Bucket(this, "SkillsBucket", {
            bucketName: `${prefix}-skills-${stack.region}-${stack.account}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: removalCondition,
            autoDeleteObjects: autoDeleteObjects,
            enforceSSL: true,
            serverAccessLogsBucket: loggingBucket,
            serverAccessLogsPrefix: `/aws/${prefix}/skills-bucket/logs`,
            lifecycleRules: [
                {
                    // Clean up old versions after 90 days
                    noncurrentVersionExpiration: cdk.Duration.days(90),
                },
            ],
        });
    }
}
