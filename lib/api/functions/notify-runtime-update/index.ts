// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import { Logger } from "@aws-lambda-powertools/logger";
import type { Context } from "aws-lambda";
import { graphQlQuery } from "./graphql";

const logger = new Logger({ serviceName: "endpointDeletionNotifier" });

interface EndpointDeletionEvent {
    agentName: string;
}

export const handler = async (event: EndpointDeletionEvent, _: Context): Promise<void> => {
    logger.info("Event", { event });

    const query = `
        mutation publishRuntimeUpdate {
            publishRuntimeUpdate(agentName: "${event.agentName}") {
                agentName
            }
        }
    `;

    await graphQlQuery(query);
};
