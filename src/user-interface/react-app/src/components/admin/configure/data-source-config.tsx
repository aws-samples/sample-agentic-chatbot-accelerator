// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";

import { createDataSource as createDataSourceMut } from "../../../graphql/mutations";
import { DataSourceConfig } from "./types";

import { ConfigurationCommonManager } from "./common";

export function DataSourceConfigurationManager(props: {
    configDialog: DataSourceConfig;
    setConfigDialog: React.Dispatch<React.SetStateAction<DataSourceConfig>>;
}) {
    const handleSave = async (config: DataSourceConfig) => {
        const client = generateClient();
        const response = await client.graphql({
            query: createDataSourceMut,
            variables: {
                kbId: config.kbId,
                dsName: config.id,
                props: config.value,
            },
        });
        return response.data.createDataSource;
    };

    return (
        <ConfigurationCommonManager
            configDialog={props.configDialog}
            setConfigDialog={props.setConfigDialog}
            configType="Data Source"
            onSave={handleSave}
        />
    );
}
