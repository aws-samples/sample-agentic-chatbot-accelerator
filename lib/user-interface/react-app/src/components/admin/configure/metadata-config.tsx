// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { MetadataConfig } from "./types";

import { generateClient } from "aws-amplify/api";
import {
    syncKnowledgeBase as syncKnowledgeBaseMut,
    updateMetadata as updateMetadataMut,
} from "../../../graphql/mutations";
import { checkOnSyncInProgress as checkOnSyncInProgressQuery } from "../../../graphql/queries";
import { ConfigurationCommonManager } from "./common";

import { ResponseStatus } from "../../../API";

export function MetadataUpdateManager(props: {
    configDialog: MetadataConfig;
    setConfigDialog: React.Dispatch<React.SetStateAction<MetadataConfig>>;
}) {
    const handleSave = async (config: MetadataConfig) => {
        const client = generateClient();
        const response = await client.graphql({
            query: updateMetadataMut,
            variables: {
                documentId: config.id,
                metadata: config.value,
            },
        });

        let out = response.data.updateMetadata;

        console.log("Update metadata status ", ResponseStatus.SUCCESSFUL);

        if (response.data.updateMetadata.status === ResponseStatus.SUCCESSFUL) {
            const syncInProgress = await client.graphql({
                query: checkOnSyncInProgressQuery,
                variables: {
                    kbId: config.kbId,
                },
            });

            console.log("Sync in progress = ", syncInProgress.data.checkOnSyncInProgress);

            if (syncInProgress.data.checkOnSyncInProgress === false) {
                console.log("Starting sync");
                const startSyncResponse = await client.graphql({
                    query: syncKnowledgeBaseMut,
                    variables: {
                        kbId: config.kbId,
                    },
                });
                out = startSyncResponse.data.syncKnowledgeBase;
            }
        }

        return out;
    };

    return (
        <ConfigurationCommonManager
            configDialog={props.configDialog}
            setConfigDialog={props.setConfigDialog}
            configType="Metadata"
            onSave={handleSave}
            nameRequired={false}
        />
    );
}
