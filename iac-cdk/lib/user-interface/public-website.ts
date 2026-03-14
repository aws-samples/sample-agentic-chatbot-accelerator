/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Definition of the construct `PublicWebsite`
*/

import * as cdk from "aws-cdk-lib";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

export interface PublicWebsiteProps {
    readonly config: SystemConfig;
    readonly websiteBucket: s3.Bucket;
}

export class PublicWebsite extends Construct {
    /**
     * Distribute the website by using CloudFront
     */
    readonly distribution: cf.Distribution;

    constructor(scope: Construct, id: string, props: PublicWebsiteProps) {
        super(scope, id);

        const prefix = generatePrefix(this);
        const account = cdk.Stack.of(this).account;

        const distributionLogsBucket = new s3.Bucket(this, "webDistributionLogs", {
            bucketName: `${prefix}-distribution-log-bucket-${account}`,
            objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
        });

        const distribution = new cf.Distribution(this, "Distribution", {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(props.websiteBucket, {
                    originAccessControl: new cf.S3OriginAccessControl(this, `${prefix}-oac`, {
                        signing: cf.Signing.SIGV4_ALWAYS,
                    }),
                }),
                cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
                viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                // responseHeadersPolicy: responseHeadersPolicy,    // todo: add response header policy
            },
            defaultRootObject: "index.html",
            errorResponses: [
                {
                    httpStatus: 403,
                    ttl: cdk.Duration.minutes(0),
                    responseHttpStatus: 200,
                    responsePagePath: "/index.html",
                },
                {
                    httpStatus: 404,
                    ttl: cdk.Duration.minutes(0),
                    responseHttpStatus: 200,
                    responsePagePath: "/index.html",
                },
            ],
            logBucket: distributionLogsBucket,
            enableLogging: true,
            logIncludesCookies: false,
            httpVersion: cf.HttpVersion.HTTP2_AND_3,
            priceClass: cf.PriceClass.PRICE_CLASS_ALL,
            minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
            geoRestriction: props.config.enableGeoRestrictions
                ? cf.GeoRestriction.allowlist(...props.config.allowedGeoRegions)
                : undefined,
        });

        this.distribution = distribution;

        /* Outputs */

        new cdk.CfnOutput(this, "UserInterfaceDomainName", {
            value: `https://${distribution.distributionDomainName}`,
        });

        NagSuppressions.addResourceSuppressions(distributionLogsBucket, [
            {
                id: "AwsSolutions-S1",
                reason: "Bucket is the server access logs bucket for websiteBucket.",
            },
        ]);

        NagSuppressions.addResourceSuppressions(props.websiteBucket, [
            { id: "AwsSolutions-S5", reason: "OAI is configured for read." },
        ]);

        NagSuppressions.addResourceSuppressions(distribution, [
            { id: "AwsSolutions-CFR1", reason: "No geo restrictions" },
            {
                id: "AwsSolutions-CFR2",
                reason: "WAF not required due to configured Cognito auth.",
            },
            { id: "AwsSolutions-CFR4", reason: "TLS 1.2 is the default." },
        ]);
    }
}
