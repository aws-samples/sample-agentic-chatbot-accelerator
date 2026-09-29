// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { StatusIndicatorProps } from "@cloudscape-design/components";

const IN_FLIGHT_RUN_STATUSES = ["Running", "Queued"];

export const isRunStatusInFlight = (status: string | null | undefined): boolean =>
    IN_FLIGHT_RUN_STATUSES.includes(status ?? "");

export function evaluationStatusType(status: string | null | undefined): StatusIndicatorProps.Type {
    if (!status) return "info";
    const s = status.toLowerCase();
    if (s === "queued" || s.endsWith("ing")) return "loading";
    if (s === "ready" || s === "completed" || s === "passed") return "success";
    if (s === "failed") return "error";
    return "info";
}

/** Pass rate or score percentage: >=80 success, >=50 warning, else error. */
export const scoreStatusType = (percent: number): "success" | "warning" | "error" =>
    percent >= 80 ? "success" : percent >= 50 ? "warning" : "error";
