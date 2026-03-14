// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
export interface BaseConfig {
    id: string;
    value: string;
    visible: boolean;
}

export interface KbConfig extends BaseConfig {}

export interface DataSourceConfig extends BaseConfig {
    kbId: string;
}

export interface MetadataConfig extends BaseConfig {
    kbId: string;
}

export type ConfigType = "Knowledge Base" | "Data Source" | "Metadata";

export type OperationStatus = "success" | "in-progress" | "failed";
