// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    BreadcrumbGroup,
    Button,
    ExpandableSection,
    FormField,
    Link,
    Modal,
    Select,
    SpaceBetween,
    StatusIndicator,
} from "@cloudscape-design/components";
import CodeView from "@cloudscape-design/code-view/code-view";
import jsonHighlight from "@cloudscape-design/code-view/highlight/json";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import { useEffect, useState } from "react";
import { RuntimeSummary } from "../../../API";
import { AgentCoreRuntimeConfiguration } from "../../wizard/types";
import AgentConfigView, { AgentReferenceTarget } from "./agent-config-view";

interface VersionInfo {
    version: string;
    qualifiers: string[];
}

// One step in the drill-down navigation. stack[0] is the agent the user opened
// from the table; the top of the stack is the agent currently displayed.
interface NavFrame {
    agentName: string;
    agentRuntimeId?: string; // needed to fetch versions; absent if unresolved
    versions: VersionInfo[];
    selectedVersion: string;
    // Set when this frame was reached by drilling into a reference: the view is
    // pinned to this referenced endpoint (read-only) instead of offering a free
    // version selector. Absent for the root frame opened from the table.
    pinnedEndpoint?: string;
    config: AgentCoreRuntimeConfiguration | null;
    error: string | null;
}

interface ViewVersionModalProps {
    visible: boolean;
    onDismiss: () => void;
    agentName: string;
    agentRuntimeId: string;
    versions: VersionInfo[];
    agents: RuntimeSummary[];
    onVersionSelect: (agentName: string, version: string) => Promise<AgentCoreRuntimeConfiguration>;
}

export default function ViewVersionModal({
    visible,
    onDismiss,
    agentName,
    agentRuntimeId,
    versions,
    agents,
    onVersionSelect,
}: ViewVersionModalProps) {
    const [stack, setStack] = useState<NavFrame[]>([]);
    const [loadingConfig, setLoadingConfig] = useState(false);

    const current = stack.length > 0 ? stack[stack.length - 1] : null;
    const agentConfig = current?.config ?? null;
    const selectedVersion = current?.selectedVersion ?? "";

    // Merge a patch into the currently displayed (top) frame.
    const updateTopFrame = (patch: Partial<NavFrame>) => {
        setStack((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], ...patch };
            return next;
        });
    };

    // Load a config for a given agent + version, normalizing fetch failures into
    // a frame-level error string (instead of a blank modal body).
    const loadConfig = async (name: string, version: string) => {
        try {
            const config = await onVersionSelect(name, version);
            return { config, error: null as string | null };
        } catch (error) {
            console.error("Failed to load agent config:", error);
            return { config: null, error: "Failed to load configuration for this version." };
        }
    };

    const handleVersionChange = async (version: string) => {
        if (!version || !current) return;

        const name = current.agentName;
        updateTopFrame({ selectedVersion: version, error: null });
        setLoadingConfig(true);
        const { config, error } = await loadConfig(name, version);
        updateTopFrame({ config, error });
        setLoadingConfig(false);
    };

    // ---- Reference resolution (Part B2) --------------------------------
    // Swarm / Graph references carry an agentName directly; Agents-as-Tools
    // carries a runtimeId that is either the HTTP id (just-added) or the A2A
    // twin ARN (persisted) — match both shapes.
    const findRuntimeByName = (name: string): RuntimeSummary | null =>
        agents.find((a) => a.agentName === name) ?? null;

    const findRuntimeById = (id: string): RuntimeSummary | null =>
        agents.find((a) => a.agentRuntimeId === id || a.agentRuntimeArnA2A === id) ?? null;

    const getAgentNameByRuntimeId = (id: string): string => findRuntimeById(id)?.agentName ?? id;

    // Push a sub-agent onto the stack and load its config. A reference targets a
    // specific endpoint, so the pushed frame is pinned to it (Part B3): we resolve
    // endpoint → version and lock the view rather than offering a version selector.
    const drillInto = async (runtime: RuntimeSummary, endpointName?: string) => {
        setLoadingConfig(true);
        try {
            const qtv = JSON.parse(runtime.qualifierToVersion || "{}");
            // The endpoint named on the reference, defaulting to DEFAULT.
            const pinnedEndpoint = endpointName || "DEFAULT";
            const version = qtv[pinnedEndpoint] ?? qtv["DEFAULT"] ?? Object.values(qtv)[0] ?? "";
            const { config, error } = await loadConfig(runtime.agentName, String(version));
            setStack((prev) => [
                ...prev,
                {
                    agentName: runtime.agentName,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versions: [],
                    selectedVersion: String(version),
                    pinnedEndpoint,
                    config,
                    error,
                },
            ]);
        } catch (error) {
            console.error("Failed to drill into sub-agent:", error);
            // Keep the parent intact; surface the failure in the pushed frame.
            setStack((prev) => [
                ...prev,
                {
                    agentName: runtime.agentName,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versions: [],
                    selectedVersion: "",
                    pinnedEndpoint: endpointName || "DEFAULT",
                    config: null,
                    error: "Failed to load this sub-agent.",
                },
            ]);
        } finally {
            setLoadingConfig(false);
        }
    };

    const goBack = () => setStack((prev) => prev.slice(0, -1));
    const popTo = (index: number) => setStack((prev) => prev.slice(0, index + 1));

    // Turn an AgentConfigView reference into a drill-down link, or a non-clickable
    // hint when the reference does not resolve to a runtime in this account (deleted,
    // cross-account, or a raw runtimeId).
    const renderAgentReference = (target: AgentReferenceTarget): React.ReactNode => {
        const runtime = target.agentName
            ? findRuntimeByName(target.agentName)
            : target.runtimeId
              ? findRuntimeById(target.runtimeId)
              : null;
        const displayName = target.runtimeId
            ? getAgentNameByRuntimeId(target.runtimeId)
            : target.display;

        if (runtime) {
            return <Link onFollow={() => drillInto(runtime, target.endpoint)}>{displayName}</Link>;
        }
        return (
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box display="inline">{displayName}</Box>
                <Box color="text-status-inactive" fontSize="body-s" display="inline">
                    (sub-agent no longer available)
                </Box>
            </SpaceBetween>
        );
    };

    // Initialize the navigation stack with the opened (root) agent.
    useEffect(() => {
        if (visible && versions.length > 0 && stack.length === 0) {
            const defaultVersion = versions.find((v) => v.qualifiers.includes("DEFAULT"));
            const versionToSelect = defaultVersion ? defaultVersion.version : versions[0].version;

            const initRoot = async () => {
                setStack([
                    {
                        agentName,
                        agentRuntimeId,
                        versions,
                        selectedVersion: versionToSelect,
                        config: null,
                        error: null,
                    },
                ]);
                setLoadingConfig(true);
                const { config, error } = await loadConfig(agentName, versionToSelect);
                updateTopFrame({ config, error });
                setLoadingConfig(false);
            };

            initRoot();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, versions]);

    const handleDismiss = () => {
        setStack([]);
        onDismiss();
    };

    const rawJson = agentConfig ? JSON.stringify(agentConfig, null, 2) : "";

    return (
        <Modal
            visible={visible}
            onDismiss={handleDismiss}
            header={`View Agent: ${current?.agentName ?? agentName}`}
            size="max"
            footer={
                <Box float="right">
                    <Button onClick={handleDismiss}>Close</Button>
                </Box>
            }
        >
            <SpaceBetween direction="vertical" size="l">
                {/* Drill-down trail: breadcrumb + Back, shown only once nested */}
                {stack.length > 1 && (
                    <SpaceBetween direction="vertical" size="xs">
                        <BreadcrumbGroup
                            ariaLabel="Sub-agent navigation"
                            items={stack.map((f, i) => ({
                                text: f.agentName,
                                href: String(i),
                            }))}
                            onFollow={(event) => {
                                event.preventDefault();
                                const index = parseInt(event.detail.href, 10);
                                if (!Number.isNaN(index)) popTo(index);
                            }}
                        />
                        <Box>
                            <Button iconName="angle-left" onClick={goBack}>
                                Back to {stack[stack.length - 2].agentName}
                            </Button>
                        </Box>
                    </SpaceBetween>
                )}

                {current?.pinnedEndpoint ? (
                    // Drilled-in via a reference: the reference targets a specific
                    // endpoint, so the view is locked to it (read-only).
                    <FormField
                        label="Endpoint"
                        constraintText="Pinned to the endpoint referenced by the parent agent"
                    >
                        <Box padding={{ top: "xxs" }}>
                            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                                <Box variant="awsui-key-label" display="inline">
                                    {current.pinnedEndpoint}
                                </Box>
                                {selectedVersion && (
                                    <Box color="text-status-inactive" display="inline">
                                        (v{selectedVersion})
                                    </Box>
                                )}
                            </SpaceBetween>
                        </Box>
                    </FormField>
                ) : (
                    <FormField label="Version" constraintText="Select version to view details">
                        <Select
                            selectedOption={
                                selectedVersion
                                    ? (() => {
                                          const foundVersion = current?.versions.find(
                                              (v) => v.version === selectedVersion,
                                          );
                                          const hasQualifiers =
                                              foundVersion?.qualifiers &&
                                              foundVersion.qualifiers.length > 0;
                                          return {
                                              label: hasQualifiers
                                                  ? `${selectedVersion} (${foundVersion!.qualifiers.join(", ")})`
                                                  : selectedVersion,
                                              value: selectedVersion,
                                          };
                                      })()
                                    : null
                            }
                            onChange={({ detail }) =>
                                handleVersionChange(detail.selectedOption?.value || "")
                            }
                            options={(current?.versions ?? []).map((v) => ({
                                label:
                                    v.qualifiers.length > 0
                                        ? `${v.version} (${v.qualifiers.join(", ")})`
                                        : v.version,
                                value: v.version,
                            }))}
                            placeholder="Select version"
                        />
                    </FormField>
                )}

                {current?.error && <Alert type="error">{current.error}</Alert>}

                {loadingConfig ? (
                    <Box textAlign="center">
                        <StatusIndicator type="loading">Loading configuration</StatusIndicator>
                    </Box>
                ) : agentConfig ? (
                    <>
                        <AgentConfigView
                            config={agentConfig}
                            renderAgentReference={renderAgentReference}
                        />

                        <ExpandableSection
                            headerText="Configuration JSON"
                            defaultExpanded={false}
                        >
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
                    </>
                ) : null}
            </SpaceBetween>
        </Modal>
    );
}
