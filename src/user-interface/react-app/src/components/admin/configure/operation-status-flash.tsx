// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Flashbar } from "@cloudscape-design/components";
import { OperationStatus } from "./types";

export default function OperationStatusFlash({
    status,
    id,
    inProgress,
    failed,
    success = "Successful",
}: {
    status: OperationStatus | undefined;
    id: string;
    inProgress: React.ReactNode;
    failed: React.ReactNode;
    success?: React.ReactNode;
}) {
    if (!status) return null;
    return (
        <Flashbar
            items={[
                {
                    type: status === "failed" ? "error" : "success",
                    content:
                        status === "failed"
                            ? failed
                            : status === "in-progress"
                              ? inProgress
                              : success,
                    loading: status === "in-progress",
                    id: `${id}-${status}`,
                },
            ]}
        />
    );
}
