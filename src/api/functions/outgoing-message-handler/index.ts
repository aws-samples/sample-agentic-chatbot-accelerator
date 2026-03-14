// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------

import { Logger } from "@aws-lambda-powertools/logger";
import type { Context, SNSEvent, SNSEventRecord } from "aws-lambda";
import { graphQlQuery } from "./graphql";

const logger = new Logger({ serviceName: "responsePublisher" });

/**
 * Run a publish response for each message in the SNS event
 */
const recordHandler = async (record: SNSEventRecord): Promise<void> => {
    const message = record.Sns.Message;
    if (message) {
        const req = JSON.parse(message);
        logger.debug("Processed message", req);

        const query = `
          mutation Mutation {
            publishResponse (data: ${JSON.stringify(
                message,
            )}, sessionId: "${req.data.sessionId}", userId: "${req.userId}") {
              data
              sessionId
              userId
            }
          }
      `;
        await graphQlQuery(query);
    }
};

export const handler = async (event: SNSEvent, context: Context): Promise<void> => {
    logger.debug("Event", { event });

    // Sort events by token sequence
    event.Records = event.Records.sort((a, b) => {
        try {
            const x: number = JSON.parse(a.Sns.Message).data?.token?.sequenceNumber;
            const y: number = JSON.parse(b.Sns.Message).data?.token?.sequenceNumber;
            return x - y;
        } catch {
            return 0;
        }
    });

    // Process each record
    for (const record of event.Records) {
        try {
            await recordHandler(record);
        } catch (error) {
            logger.error("Failed to process record", { error, record });
            // Continue processing other records
        }
    }
};
