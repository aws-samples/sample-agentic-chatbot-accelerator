/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { SystemConfig } from "../shared/types";
import { generatePrefix } from "../shared/utils";

/**
 * Authentication class that sets up AWS Cognito resources for user authentication
 * Creates and configures:
 * - Cognito User Pool for managing user accounts and authentication
 * - User Pool Client for application access to the User Pool
 * - Identity Pool for providing temporary AWS credentials
 */
export class Authentication extends Construct {
    /** The Cognito User Pool instance */
    public readonly userPool: cognito.UserPool;
    /** The User Pool Client instance */
    public readonly userPoolClient: cognito.UserPoolClient;
    /** The Cognito Identity Pool instance */
    public readonly identityPool: cognitoIdentityPool.IdentityPool;

    /**
     * Creates a new Authentication construct
     * @param scope The scope in which to define this construct
     * @param id The scoped construct ID
     * @param config System configuration including prefix for resource names
     */
    constructor(scope: Construct, id: string, config: SystemConfig) {
        super(scope, id);
        const prefix = generatePrefix(this);

        // Create Cognito User Pool with email sign-in and optional MFA
        const userPool = new cognito.UserPool(this, "UserPool", {
            userPoolName: `${prefix}-userPool`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            selfSignUpEnabled: false,
            mfa: cognito.Mfa.OPTIONAL,
            autoVerify: { email: true, phone: true },
            signInAliases: {
                email: true,
            },
            standardAttributes: {
                givenName: {
                    required: true,
                    mutable: true,
                },
                familyName: {
                    required: true,
                    mutable: true,
                },
            },
        });

        // Create User Pool Client with various auth flows enabled
        const userPoolClient = userPool.addClient("UserPoolClient", {
            generateSecret: false,
            authFlows: {
                adminUserPassword: true,
                userPassword: true,
                userSrp: true,
            },
        });

        // Create Identity Pool linked to the User Pool
        const identityPool = new cognitoIdentityPool.IdentityPool(this, "IdentityPool", {
            authenticationProviders: {
                userPools: [
                    new cognitoIdentityPool.UserPoolAuthenticationProvider({
                        userPool,
                        userPoolClient,
                    }),
                ],
            },
        });

        this.userPool = userPool;
        this.userPoolClient = userPoolClient;
        this.identityPool = identityPool;

        // Output important resource IDs and links
        new cdk.CfnOutput(this, "UserPoolId", {
            value: userPool.userPoolId,
        });

        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.identityPoolId,
        });

        new cdk.CfnOutput(this, "UserPoolWebClientId", {
            value: userPoolClient.userPoolClientId,
        });

        new cdk.CfnOutput(this, "UserPoolLink", {
            value: `https://${
                cdk.Stack.of(this).region
            }.console.aws.amazon.com/cognito/v2/idp/user-pools/${
                userPool.userPoolId
            }/users?region=${cdk.Stack.of(this).region}`,
        });

        /**
         * CDK NAG suppression
         */
        NagSuppressions.addResourceSuppressions(userPool, [
            {
                id: "AwsSolutions-COG1",
                reason: "Default password policy requires min length of 8, digits, lowercase characters, symbols and uppercase characters: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.PasswordPolicy.html",
            },
            {
                id: "AwsSolutions-COG2",
                reason: "MFA not required for demo purpose.",
            },
            {
                id: "AwsSolutions-COG3",
                reason: "Premium security features not required because this project is for demo only.",
            },
        ]);
        NagSuppressions.addResourceSuppressions(userPool.node.findChild("smsRole"), [
            {
                id: "AwsSolutions-IAM5",
                reason: "IAM role implicitly created by CDK.",
            },
        ]);
    }
}
