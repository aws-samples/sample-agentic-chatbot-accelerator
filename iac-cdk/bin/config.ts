/* Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
*/
import { existsSync, readFileSync } from "fs";
import * as yaml from "js-yaml";
import { SystemConfig } from "../lib/shared/types";

/**
 * Apply every default a raw config.yaml may omit.
 *
 * Exported so "an absent key means on" is assertable without reading a
 * developer's real bin/config.yaml — getConfig() cannot be used for that, and
 * decision 6 keeps the new tests off it entirely. Idempotent: applying it twice
 * is applying it once.
 *
 * Note on `deployUserInterface`: getConfig() parses YAML with a cast, not a
 * validation. Under CORE_SCHEMA only the literals `true` / `false` become real
 * booleans, so `deployUserInterface: no` reaches us as the string "no" (which
 * is truthy). Treat any non-`false` value as on, so a YAML 1.1 misspelling
 * cannot silently delete the website.
 */
export function withDefaults(raw: SystemConfig): SystemConfig {
    return {
        ...raw,
        deployUserInterface: raw.deployUserInterface === false ? false : true,
    };
}

export function getConfig(): SystemConfig {
    if (existsSync("./bin/config.yaml")) {
        const yamlContent = readFileSync("./bin/config.yaml", "utf8");
        return withDefaults(yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA }) as SystemConfig);
    }
    // The default configuration:
    //  - Uses "dev" prefix for all resource names
    //  - Disables geographic restrictions (CloudFront accessible globally)
    //  - Configures three Bedrock models: Claude Haiku 4.5, Claude Sonnet 4.6, and Nova 2 Lite
    //  - Does not deploy constructs related to Knowledge Base
    //  - Does not deploy AgentCore runtime meaning that users will have to create those from the application
    //  - Registers only the invoke_subagent tool for sub-agent orchestration
    //  - Ingestion Lambda: 3-minute timeout, 20 reserved concurrent executions
    //  - Observability: Transaction Search disabled by default (see docs/src/troubleshooting.md)
    //      Set enableTransactionSearch to true if it's not already enabled in your AWS account.
    //      Without Transaction Search enabled, agent traces will not be generated.
    return withDefaults({
        prefix: "dev",
        enableGeoRestrictions: false,
        allowedGeoRegions: [],

        toolRegistry: [],

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
                TrajectoryEvaluator: `Evaluate the agent's action sequence based on:
                    1. Efficiency - Did the agent take the most direct path to achieve the goal?
                    2. Correctness - Were the right tools selected for each step?
                    3. Order - Were actions performed in a logical sequence?
                    4. Completeness - Were all necessary steps included without skipping critical actions?

                    Score 1.0 if the trajectory was optimal and all criteria are met.
                    Score 0.5 if the trajectory achieved the goal but with unnecessary steps or minor inefficiencies.
                    Score 0.0 if the trajectory was significantly flawed or failed to achieve the goal.`,
                InteractionsEvaluator: `Evaluate the interaction based on:
                    1. Correct node execution order
                    2. Proper dependency handling
                    3. Clear message communication

                    Score 1.0 if all criteria are met.
                    Score 0.5 if some issues exist.
                    Score 0.0 if interaction is incorrect.`,
            },
        },

        experimentsConfig: {},
    });
}

export const config: SystemConfig = getConfig();
