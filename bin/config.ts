/* Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/
import { existsSync, readFileSync } from "fs";
import * as yaml from "js-yaml";
import { SystemConfig } from "../lib/shared/types";

export function getConfig(): SystemConfig {
    if (existsSync("./bin/config.yaml")) {
        const yamlContent = readFileSync("./bin/config.yaml", "utf8");
        return yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA }) as SystemConfig;
    }
    // The default configuration:
    //  - Uses "dev" prefix for all resource names
    //  - Disables geographic restrictions (CloudFront accessible globally)
    //  - Configures three Bedrock models: Claude Haiku 4.5, Claude Sonnet 4.5, and Nova 2 Lite
    //  - Does not deploy constructs related to Knowledge Base
    //  - Does not deploy AgentCore runtime meaning that users will have to create those from the application
    //  - Registers only the invoke_subagent tool for sub-agent orchestration
    //  - Ingestion Lambda: 3-minute timeout, 20 reserved concurrent executions
    //  - Observability: Transaction Search disabled by default (see docs/src/troubleshooting.md)
    //      Set enableTransactionSearch to true if it's not already enabled in your AWS account.
    //      Without Transaction Search enabled, agent traces will not be generated.
    return {
        prefix: "dev",
        enableGeoRestrictions: false,
        allowedGeoRegions: [],

        supportedModels: {
            "Claude Haiku 4.5": "[REGION-PREFIX].anthropic.claude-haiku-4-5-20251001-v1:0",
            "Claude Sonnet 4.5": "[REGION-PREFIX].anthropic.claude-sonnet-4-5-20250929-v1:0",
            "Nova 2 Lite": "[REGION-PREFIX].amazon.nova-2-lite-v1:0",
        },

        toolRegistry: [
            {
                name: "invoke_subagent",
                description:
                    "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing",
                invokesSubAgent: true,
            },
        ],

        // See docs/src/expanding-ai-tools.md#Configuration for an example
        mcpServerRegistry: [],

        ingestionLambdaProps: {
            timeoutInMinutes: 3,
            reservedConcurrency: 20,
        },

        agentCoreObservability: {
            // Transaction Search is an account-level X-Ray setting for distributed tracing.
            // Set to true ONLY if Transaction Search is not already enabled in your AWS account.
            // If already enabled, keep false to avoid deployment errors (see docs/src/troubleshooting.md).
            enableTransactionSearch: false,
            indexingPercentage: 10, // Percentage of traces to index (1-100)
        },

        evaluatorConfig: {
            // Models available for LLM-based evaluations
            supportedModels: {
            "Claude Haiku 4.5": "[REGION-PREFIX].anthropic.claude-haiku-4-5-20251001-v1:0",
            "Claude Sonnet 4.5": "[REGION-PREFIX].anthropic.claude-sonnet-4-5-20250929-v1:0",
            "Nova 2 Lite": "[REGION-PREFIX].amazon.nova-2-lite-v1:0",
            },
            // Score threshold (0.0-1.0) above which a test case is considered passed
            passThreshold: 0.8,
            defaultRubrics: {
                OutputEvaluator: `Evaluate the response based on:
                    1. Accuracy - Is the information correct compared to expected output?
                    2. Completeness - Does it fully answer the question?
                    3. Clarity - Is it easy to understand?

                    Score 1.0 if all criteria are met excellently.
                    Score 0.5 if some criteria are partially met.
                    Score 0.0 if the response is inadequate.`,
            },
        },
    };
}

export const config: SystemConfig = getConfig();
