// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// -----------------------------------------------------------------------
import {
    Alert,
    BreadcrumbGroup,
    ContentLayout,
    Header,
    SpaceBetween,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import BaseAppLayout from "../../components/base-app-layout";
import AgentCoreRuntimeCreatorWizard from "../../components/wizard/agent-core-runtime-wizard";
import { AgentCoreRuntimeConfiguration } from "../../components/wizard/types";
import { ArchitectureType } from "../../API";
import { createAgentCoreRuntime as createAgentCoreRuntimeMut } from "../../graphql/mutations";
import { getDefaultRuntimeConfiguration as getDefaultRuntimeConfigurationQuery } from "../../graphql/queries";

export default function AgentCoreWizardPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const onFollow = useOnFollow();
    const apiClient = useMemo(() => generateClient(), []);

    const [isCreating, setIsCreating] = useState(false);
    const [initialData, setInitialData] = useState<AgentCoreRuntimeConfiguration | undefined>(
        undefined,
    );
    const [isLoadingInitialData, setIsLoadingInitialData] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fromAgentName = searchParams.get("from");

    // Load initial data if creating a new version from an existing agent
    const loadInitialData = useCallback(async () => {
        if (fromAgentName) {
            setIsLoadingInitialData(true);
            try {
                const result = await apiClient.graphql({
                    query: getDefaultRuntimeConfigurationQuery,
                    variables: { agentName: fromAgentName },
                });
                const rawConfig = JSON.parse(
                    result.data.getDefaultRuntimeConfiguration,
                );

                // Detect if this is a swarm configuration
                const isSwarm =
                    rawConfig &&
                    (Array.isArray(rawConfig.agents) || Array.isArray(rawConfig.agentReferences)) &&
                    typeof rawConfig.entryAgent === "string";

                if (isSwarm) {
                    setInitialData({
                        agentName: fromAgentName,
                        architectureType: "SWARM",
                        swarmConfig: rawConfig,
                        instructions: "",
                        tools: [],
                        toolParameters: {},
                        mcpServers: [],
                        conversationManager: rawConfig.conversationManager || "sliding_window",
                        modelInferenceParameters: {
                            modelId: "",
                            parameters: { temperature: 0.2, maxTokens: 3000 },
                        },
                    });
                } else {
                    const config = rawConfig as AgentCoreRuntimeConfiguration;
                    config.agentName = fromAgentName;
                    config.architectureType = "SINGLE";
                    setInitialData(config);
                }
            } catch (error) {
                console.error("Failed to load initial configuration:", error);
                navigate("/agent-core");
            } finally {
                setIsLoadingInitialData(false);
            }
        }
    }, [fromAgentName, apiClient, navigate]);

    useEffect(() => {
        loadInitialData();
    }, [loadInitialData]);

    const handleSubmit = async (config: AgentCoreRuntimeConfiguration) => {
        setIsCreating(true);
        setError(null); // Clear previous errors
        try {
            const { agentName, architectureType, swarmConfig, ...singleConfigValues } = config;

            let configValue: string;
            if (architectureType === "SWARM" && swarmConfig) {
                configValue = JSON.stringify(swarmConfig);
            } else {
                configValue = JSON.stringify(singleConfigValues);
            }

            await apiClient.graphql({
                query: createAgentCoreRuntimeMut,
                variables: {
                    agentName: config.agentName,
                    configValue,
                    architectureType: (architectureType || "SINGLE") as ArchitectureType,
                },
            });

            // Navigate back to the manager page with subscribeAgent param
            // to trigger the subscription for tracking the creation progress
            navigate(`/agent-core?subscribeAgent=${encodeURIComponent(config.agentName)}`);
        } catch (err) {
            console.error("Failed to create agent:", err);
            const errorMessage =
                err instanceof Error
                    ? err.message
                    : "An unexpected error occurred while creating the agent.";
            setError(`Failed to create agent: ${errorMessage}`);
            setIsCreating(false);
        }
    };

    const handleCancel = () => {
        navigate("/agent-core");
    };

    if (isLoadingInitialData) {
        return (
            <BaseAppLayout
                contentType="wizard"
                breadcrumbs={
                    <BreadcrumbGroup
                        onFollow={onFollow}
                        items={[
                            {
                                text: CHATBOT_NAME,
                                href: "/",
                            },
                            {
                                text: "AgentCore Manager",
                                href: "/agent-core",
                            },
                            {
                                text: "Create Runtime",
                                href: "/agent-core/create",
                            },
                        ]}
                    />
                }
                content={
                    <ContentLayout header={<Header variant="h1">Loading...</Header>}>
                        <div>Loading agent configuration...</div>
                    </ContentLayout>
                }
            />
        );
    }

    return (
        <BaseAppLayout
            contentType="wizard"
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        {
                            text: CHATBOT_NAME,
                            href: "/",
                        },
                        {
                            text: "AgentCore Manager",
                            href: "/agent-core",
                        },
                        {
                            text: fromAgentName ? "Create New Version" : "Create Runtime",
                            href: "/agent-core/create",
                        },
                    ]}
                />
            }
            content={
                <ContentLayout
                    header={
                        <Header
                            variant="h1"
                            description={
                                fromAgentName
                                    ? `Creating a new version for agent: ${fromAgentName}`
                                    : "Configure and create a new AgentCore runtime"
                            }
                        >
                            {fromAgentName ? "Create New Version" : "Create AgentCore Runtime"}
                        </Header>
                    }
                >
                    <SpaceBetween direction="vertical" size="l">
                        {error && (
                            <Alert
                                type="error"
                                dismissible
                                onDismiss={() => setError(null)}
                                header="Agent creation failed"
                            >
                                {error}
                            </Alert>
                        )}
                        <AgentCoreRuntimeCreatorWizard
                            onSubmit={handleSubmit}
                            onCancel={handleCancel}
                            isCreating={isCreating}
                            initialData={initialData}
                            asPage={true}
                        />
                    </SpaceBetween>
                </ContentLayout>
            }
        />
    );
}
