// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Alert, ExpandableSection, SpaceBetween } from "@cloudscape-design/components";
import CodeView from "@cloudscape-design/code-view/code-view";
import jsonHighlight from "@cloudscape-design/code-view/highlight/json";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import { RuntimeSummary } from "../../../API";
import AgentConfigView from "../../admin/agent-core/agent-config-view";
import { AgentCoreRuntimeConfiguration } from "../types";
import { STEP_MIN_HEIGHT } from "../wizard-utils";

interface ReviewStepProps {
    /**
     * Configuration in the flattened shape AgentConfigView understands (architecture
     * fields at the top level). For multi-agent architectures the caller spreads its
     * nested swarm/graph/agents-as-tools config to the root before passing it in.
     */
    config: AgentCoreRuntimeConfiguration;
    /** Per-architecture summary line shown above the structured view (edit flow only). */
    summary: string;
    /** Whether the wizard is in create mode (hides the summary alert when true). */
    isCreating: boolean;
    /**
     * Object to serialize in the raw JSON block. Defaults to `config`. Multi-agent
     * architectures pass the nested submission-shaped object here so the JSON matches
     * what gets saved, while `config` stays flattened for the structured view.
     */
    rawForJson?: unknown;
    /** Known runtimes, so agents-as-tools references show agent names, not raw ARNs. */
    agents?: RuntimeSummary[];
}

/**
 * Shared agent-creation wizard Review step. Renders the same structured, per-architecture
 * view as the AgentCore "View" modal (via AgentConfigView), with the raw configuration
 * JSON available in a collapsed, copyable code block underneath.
 */
export default function ReviewStep({
    config,
    summary,
    isCreating,
    rawForJson,
    agents,
}: ReviewStepProps) {
    const rawJson = JSON.stringify(rawForJson ?? config, null, 2);
    return (
        <div style={{ minHeight: STEP_MIN_HEIGHT }}>
            <SpaceBetween direction="vertical" size="l">
                {!isCreating && (
                    <Alert type="info" header="Configuration Summary">
                        {summary}
                    </Alert>
                )}

                <AgentConfigView config={config} agents={agents} />

                <ExpandableSection headerText="Configuration JSON" defaultExpanded={false}>
                    <CodeView
                        content={rawJson}
                        highlight={jsonHighlight}
                        wrapLines
                        actions={
                            <CopyToClipboard
                                variant="icon"
                                textToCopy={rawJson}
                                copySuccessText="Configuration copied"
                                copyErrorText="Failed to copy"
                            />
                        }
                    />
                </ExpandableSection>
            </SpaceBetween>
        </div>
    );
}
