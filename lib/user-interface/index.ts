/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { execSync, ExecSyncOptionsWithBufferEncoding } from "node:child_process";
import * as path from "node:path";

import { ChatbotApi } from "../api";
import { SystemConfig } from "../shared/types";
import { generatePrefix, Utils } from "../shared/utils";
import { PublicWebsite } from "./public-website";

/**
 * Properties of the UserInterface construct
 */
export interface UserInterfaceProps {
    readonly config: SystemConfig;
    readonly userPoolId: string;
    readonly userPoolClientId: string;
    readonly identityPool: cognitoIdentityPool.IdentityPool;
    readonly api: ChatbotApi;
    readonly dataBucket?: s3.Bucket;
}

/**
 * AWS resources to publish React app
 *
 * TODO: support private website hosting (current version deploy a public facing URL)
 */
export class UserInterface extends Construct {
    public readonly publishedDomain: string;

    /**
     * Creates a new `UserInterface`
     * @param scope ...
     * @param id ...
     * @param props ...
     */
    constructor(scope: Construct, id: string, props: UserInterfaceProps) {
        super(scope, id);

        const pathToApp = path.join(__dirname, "react-app");
        const pathToBuild = path.join(pathToApp, "dist");

        const prefix = generatePrefix(this);
        const account = cdk.Stack.of(this).account;

        const logsBucket = new s3.Bucket(this, "WebsiteLogsBucket", {
            bucketName: `${prefix}-website-log-bucket-${account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
        });

        const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
            bucketName: `${prefix}-website-bucket-${account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            enforceSSL: true,
            serverAccessLogsBucket: logsBucket,
        });

        const publicWebsite = new PublicWebsite(this, "PublicWebsite", {
            ...props,
            websiteBucket: websiteBucket,
        });
        const distribution = publicWebsite.distribution;
        this.publishedDomain = publicWebsite.distribution.distributionDomainName;

        // Add permissions for authenticated users to upload to the data bucket
        if (props.dataBucket) {
            props.identityPool.authenticatedRole.addToPrincipalPolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:DeleteObject"],
                    resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
                }),
            );
        }

        const exportsAsset = s3deploy.Source.jsonData("aws-exports.json", {
            aws_project_region: cdk.Aws.REGION,
            aws_cognito_region: cdk.Aws.REGION,
            aws_user_pools_id: props.userPoolId,
            aws_user_pools_web_client_id: props.userPoolClientId,
            aws_cognito_identity_pool_id: props.identityPool.identityPoolId,
            Auth: {
                region: cdk.Aws.REGION,
                userPoolId: props.userPoolId,
                userPoolWebClientId: props.userPoolClientId,
            },
            aws_appsync_graphqlEndpoint: props.api.graphqlApi.graphqlUrl,
            aws_appsync_region: cdk.Aws.REGION,
            aws_appsync_authenticationType: "AMAZON_COGNITO_USER_POOLS",
            // Conditionally include S3 bucket config only if dataBucket is defined
            ...(props.dataBucket && {
                aws_user_files_s3_bucket: props.dataBucket.bucketName,
                aws_user_files_s3_bucket_region: cdk.Aws.REGION,
            }),
            // Define supported models from the stack at deployment time
            aws_bedrock_supported_models: props.config.supportedModels,
            ...(props.config.rerankingModels && {
                aws_bedrock_supported_reranking_models: props.config.rerankingModels,
            }),

            // Evaluator configuration
            ...(props.config.evaluatorConfig && {
                evaluatorConfig: props.config.evaluatorConfig,
            }),

            // Feature flags
            knowledgeBaseIsSupported: !!props.dataBucket,

            // Todo - fill if you want to keep track of deployment configuration.
            config: {},
        });

        if (props.dataBucket) {
            const cfnBucket = props.dataBucket.node.defaultChild as s3.CfnBucket;
            cfnBucket.addPropertyOverride("CorsConfiguration", {
                CorsRules: [
                    {
                        AllowedHeaders: ["*"],
                        AllowedMethods: [
                            s3.HttpMethods.PUT,
                            s3.HttpMethods.POST,
                            s3.HttpMethods.GET,
                            s3.HttpMethods.DELETE,
                            s3.HttpMethods.HEAD,
                        ],
                        AllowedOrigins: [
                            cdk.Token.asString(`https://${this.publishedDomain}`),
                            "http://localhost:3000",
                        ],
                        ExposedHeaders: [
                            "ETag",
                            "x-amz-server-side-encryption",
                            "x-amz-request-id",
                            "x-amz-id-2",
                        ],
                    },
                ],
            });
        }

        const asset = s3deploy.Source.asset(pathToApp, {
            bundling: {
                image: cdk.DockerImage.fromRegistry("public.ecr.aws/sam/build-nodejs18.x:latest"),
                command: [
                    "sh",
                    "-c",
                    [
                        "npm --cache /tmp/.npm install",
                        `npm --cache /tmp/.npm run build`,
                        "cp -aur /asset-input/dist/* /asset-output/",
                    ].join(" && "),
                ],
                local: {
                    tryBundle(outputDir: string) {
                        try {
                            const options: ExecSyncOptionsWithBufferEncoding = {
                                stdio: "inherit",
                                env: {
                                    ...process.env,
                                },
                            };

                            // Safe because the command is not user provided
                            execSync(`npm --silent --prefix "${pathToApp}" ci`, options); //NOSONAR Needed for the build process.
                            execSync(`npm --silent --prefix "${pathToApp}" run build`, options); //NOSONAR
                            Utils.copyDirRecursive(pathToBuild, outputDir);
                        } catch (e) {
                            console.error(e);
                            return false;
                        }

                        return true;
                    },
                },
            },
        });

        new s3deploy.BucketDeployment(this, "UserInterfaceDeployment", {
            prune: false,
            sources: [asset, exportsAsset],
            destinationBucket: websiteBucket,
            distribution: distribution,
        });

        /**
         * CDK NAG suppression
         */
        NagSuppressions.addResourceSuppressions(logsBucket, [
            {
                id: "AwsSolutions-S1",
                reason: "Bucket is the server access logs bucket for websiteBucket.",
            },
        ]);
        NagSuppressions.addResourceSuppressions(
            props.identityPool.authenticatedRole,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "The wildcard is to cover all the objects in the data bucket.",
                },
            ],
            true,
        );
    }
}
