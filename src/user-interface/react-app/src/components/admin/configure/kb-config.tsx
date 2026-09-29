// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import { createKnowledgeBase as createKnowledgeBaseMut } from "../../../graphql/mutations";
import { KbConfig } from "./types";

import { ConfigurationCommonManager } from "./common";
import { apiClient } from "../../../common/api-client";

export function KbConfigurationManager(props: {
    configDialog: KbConfig;
    setConfigDialog: React.Dispatch<React.SetStateAction<KbConfig>>;
}) {
    const handleSave = async (config: KbConfig) => {
        const response = await apiClient.graphql({
            query: createKnowledgeBaseMut,
            variables: {
                kbName: config.id,
                props: config.value,
            },
        });
        return response.data.createKnowledgeBase;
    };

    return (
        <ConfigurationCommonManager
            configDialog={props.configDialog}
            setConfigDialog={props.setConfigDialog}
            configType="Knowledge Base"
            onSave={handleSave}
        />
    );
}
