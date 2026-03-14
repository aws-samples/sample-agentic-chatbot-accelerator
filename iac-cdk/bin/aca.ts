#!/usr/bin/env node

// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import "source-map-support/register";
import { AcaStack } from "../lib/aca-stack";
import { getConfig } from "./config";

const app = new cdk.App();
const config = getConfig();

// in principle if the prefix is `dev` the stack should be called dev-aca
// however, we, treat `dev` as default config. This might be changed if you are starting from scratch in a new account
const baseName = "aca";
const stackName = config.prefix == "" ? baseName : `${config.prefix}-${baseName}`;
const stack = new AcaStack(app, stackName, {
    config: config,
});
cdk.Tags.of(stack).add("Stack", baseName.toLowerCase());
cdk.Tags.of(stack).add("Team", "genaiic");
if (config.prefix) {
    cdk.Tags.of(stack).add("Environment", config.prefix.toLowerCase());
}
cdk.Aspects.of(app).add(new AwsSolutionsChecks());
