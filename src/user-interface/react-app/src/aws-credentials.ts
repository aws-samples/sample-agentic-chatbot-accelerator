// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
//
// Module: AWS Credentials Helper
//
// Exchanges Cognito User Pool JWT tokens for temporary AWS credentials
// via the Cognito Identity Pool. These credentials are used to SigV4-sign
// WebSocket connections to AgentCore runtimes.
//
import {
    CognitoIdentityClient,
    GetCredentialsForIdentityCommand,
    GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { fetchAuthSession } from "aws-amplify/auth";

export interface AWSCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration?: Date;
}

let cachedCredentials: AWSCredentials | null = null;
let credentialsExpiry: Date | null = null;

/**
 * Get the current Cognito ID token from the Amplify auth session.
 */
async function getIdToken(): Promise<string | null> {
    try {
        const session = await fetchAuthSession();
        return session.tokens?.idToken?.toString() ?? null;
    } catch {
        return null;
    }
}

/**
 * Exchange a Cognito JWT for temporary AWS credentials via the Identity Pool.
 *
 * Credentials are cached and reused until 5 minutes before expiry.
 *
 * @param config - The app configuration containing region, user pool, and identity pool IDs
 */
export async function getAWSCredentials(config: {
    aws_project_region: string;
    aws_user_pools_id: string;
    aws_cognito_identity_pool_id: string;
}): Promise<AWSCredentials> {
    // Return cached credentials if still valid (with 5 min buffer)
    if (cachedCredentials && credentialsExpiry) {
        const now = new Date();
        const bufferMs = 5 * 60 * 1000;
        if (credentialsExpiry.getTime() - now.getTime() > bufferMs) {
            return cachedCredentials;
        }
    }

    const idToken = await getIdToken();
    if (!idToken) throw new Error("Not authenticated — no ID token available");

    const region = config.aws_project_region;
    const userPoolId = config.aws_user_pools_id;
    const identityPoolId = config.aws_cognito_identity_pool_id;

    const client = new CognitoIdentityClient({ region });
    const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;

    // Step 1: Get identity ID
    const { IdentityId } = await client.send(
        new GetIdCommand({
            IdentityPoolId: identityPoolId,
            Logins: { [providerName]: idToken },
        }),
    );

    // Step 2: Get temporary credentials
    const { Credentials } = await client.send(
        new GetCredentialsForIdentityCommand({
            IdentityId,
            Logins: { [providerName]: idToken },
        }),
    );

    if (!Credentials?.AccessKeyId || !Credentials?.SecretKey || !Credentials?.SessionToken) {
        throw new Error("Failed to obtain AWS credentials from Identity Pool");
    }

    cachedCredentials = {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretKey,
        sessionToken: Credentials.SessionToken,
        expiration: Credentials.Expiration,
    };
    credentialsExpiry = Credentials.Expiration ?? null;

    return cachedCredentials;
}

/**
 * Clear cached credentials (e.g. on sign-out).
 */
export function clearCredentials(): void {
    cachedCredentials = null;
    credentialsExpiry = null;
}
