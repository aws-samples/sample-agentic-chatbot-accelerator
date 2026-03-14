// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import {
    Alert,
    Box,
    Button,
    FormField,
    Input,
    Modal,
    RadioGroup,
    Select,
    SpaceBetween,
    Textarea,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useState } from "react";
import { McpAuthType, ResponseStatus } from "../../API";
import { AppContext } from "../../common/app-context";
import { registerMcpServer as registerMcpServerMutation } from "../../graphql/mutations";

const AUTH_TYPE_OPTIONS = [
    { label: "SigV4 (IAM auth) — recommended", value: McpAuthType.SIGV4 },
    { label: "None (public endpoint)", value: McpAuthType.NONE },
];

type HostingType = "runtime" | "gateway";

export interface RegisterMcpServerModalProps {
    visible: boolean;
    onDismiss: () => void;
    onSuccess: () => void;
}

export function RegisterMcpServerModal({
    visible,
    onDismiss,
    onSuccess,
}: RegisterMcpServerModalProps) {
    const appContext = useContext(AppContext);
    const [name, setName] = useState("");
    const [authType, setAuthType] = useState(AUTH_TYPE_OPTIONS[0]);
    const [hostingType, setHostingType] = useState<HostingType>("runtime");
    const [runtimeId, setRuntimeId] = useState("");
    const [gatewayId, setGatewayId] = useState("");
    const [qualifier, setQualifier] = useState("");
    const [url, setUrl] = useState("");
    const [description, setDescription] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const apiClient = generateClient();

    const nameValid = /^[a-zA-Z0-9_-]{1,64}$/.test(name);
    const isSigV4 = authType.value === McpAuthType.SIGV4;
    const isNone = authType.value === McpAuthType.NONE;

    // Validation
    const sigv4Valid =
        isSigV4 &&
        ((hostingType === "runtime" && runtimeId.trim().length > 0) ||
            (hostingType === "gateway" && gatewayId.trim().length > 0));
    const noneValid = isNone && url.startsWith("https://");
    const canSubmit = nameValid && (sigv4Valid || noneValid) && !submitting;

    const resetForm = () => {
        setName("");
        setAuthType(AUTH_TYPE_OPTIONS[0]);
        setHostingType("runtime");
        setRuntimeId("");
        setGatewayId("");
        setQualifier("");
        setUrl("");
        setDescription("");
        setError(null);
    };

    const handleDismiss = () => {
        resetForm();
        onDismiss();
    };

    const handleSubmit = async () => {
        if (!appContext || !canSubmit) return;
        setSubmitting(true);
        setError(null);

        try {
            const result = await apiClient.graphql({
                query: registerMcpServerMutation,
                variables: {
                    name,
                    authType: authType.value as McpAuthType,
                    description: description || undefined,
                    runtimeId: isSigV4 && hostingType === "runtime" ? runtimeId.trim() : undefined,
                    gatewayId: isSigV4 && hostingType === "gateway" ? gatewayId.trim() : undefined,
                    qualifier:
                        isSigV4 && hostingType === "runtime" && qualifier.trim()
                            ? qualifier.trim()
                            : undefined,
                    mcpUrl: isNone ? url : undefined,
                },
            });

            const status = result.data?.registerMcpServer?.status;
            if (status === ResponseStatus.SUCCESSFUL) {
                resetForm();
                onSuccess();
            } else if (status === ResponseStatus.ALREADY_EXISTS) {
                setError(`An MCP server named "${name}" already exists.`);
            } else if (status === ResponseStatus.INVALID_NAME) {
                setError(
                    "Invalid server name. Use only letters, numbers, hyphens, and underscores (max 64 chars).",
                );
            } else if (status === ResponseStatus.INVALID_CONFIG) {
                setError(
                    isSigV4
                        ? "Invalid configuration. The AgentCore runtime or gateway was not found. Please verify the ID and try again."
                        : "Invalid configuration. URL must start with https://.",
                );
            } else {
                setError(`Registration failed with status: ${status}`);
            }
        } catch (e: unknown) {
            if (e instanceof Error) {
                setError(`Error: ${e.message}`);
            } else if (
                typeof e === "object" &&
                e !== null &&
                "errors" in e &&
                Array.isArray((e as { errors: { message: string }[] }).errors)
            ) {
                const messages = (e as { errors: { message: string }[] }).errors
                    .map((err) => err.message)
                    .join("; ");
                setError(`Error: ${messages}`);
            } else {
                setError(`Error: ${JSON.stringify(e)}`);
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            visible={visible}
            onDismiss={handleDismiss}
            header="Register MCP Server"
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={handleDismiss}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSubmit}
                            loading={submitting}
                            disabled={!canSubmit}
                        >
                            Register
                        </Button>
                    </SpaceBetween>
                </Box>
            }
        >
            <SpaceBetween size="l">
                {error && <Alert type="error">{error}</Alert>}

                <FormField
                    label="Server name"
                    description="Unique identifier (alphanumeric, hyphens, underscores, max 64 chars)"
                    errorText={name.length > 0 && !nameValid ? "Invalid name format" : undefined}
                >
                    <Input
                        value={name}
                        onChange={({ detail }) => setName(detail.value)}
                        placeholder="my-mcp-server"
                    />
                </FormField>

                <FormField
                    label="Authentication type"
                    description="How the agent runtime authenticates to this server"
                >
                    <Select
                        selectedOption={authType}
                        options={AUTH_TYPE_OPTIONS}
                        onChange={({ detail }) =>
                            setAuthType(detail.selectedOption as typeof authType)
                        }
                    />
                </FormField>

                {/* ---- SigV4 fields ---- */}
                {isSigV4 && (
                    <>
                        <FormField label="Hosting type">
                            <RadioGroup
                                value={hostingType}
                                onChange={({ detail }) =>
                                    setHostingType(detail.value as HostingType)
                                }
                                items={[
                                    {
                                        value: "runtime",
                                        label: "AgentCore Runtime",
                                        description:
                                            "MCP server hosted on Bedrock AgentCore Runtime",
                                    },
                                    {
                                        value: "gateway",
                                        label: "AgentCore Gateway",
                                        description:
                                            "MCP server hosted on Bedrock AgentCore Gateway",
                                    },
                                ]}
                            />
                        </FormField>

                        {hostingType === "runtime" && (
                            <>
                                <FormField
                                    label="Runtime ID"
                                    description="The runtime identifier from your AgentCore deployment (e.g. mcp_server_iam-abcd9876)"
                                    errorText={
                                        runtimeId.length > 0 && runtimeId.trim().length === 0
                                            ? "Runtime ID is required"
                                            : undefined
                                    }
                                >
                                    <Input
                                        value={runtimeId}
                                        onChange={({ detail }) => setRuntimeId(detail.value)}
                                        placeholder="mcp_server_iam-abcd9876"
                                    />
                                </FormField>
                                <FormField
                                    label="Qualifier (optional)"
                                    description='Endpoint qualifier, defaults to "DEFAULT" if not specified'
                                >
                                    <Input
                                        value={qualifier}
                                        onChange={({ detail }) => setQualifier(detail.value)}
                                        placeholder="DEFAULT"
                                    />
                                </FormField>
                            </>
                        )}

                        {hostingType === "gateway" && (
                            <FormField
                                label="Gateway ID"
                                description="The gateway identifier from your AgentCore deployment (e.g. test-xywz1234)"
                                errorText={
                                    gatewayId.length > 0 && gatewayId.trim().length === 0
                                        ? "Gateway ID is required"
                                        : undefined
                                }
                            >
                                <Input
                                    value={gatewayId}
                                    onChange={({ detail }) => setGatewayId(detail.value)}
                                    placeholder="test-xywz1234"
                                />
                            </FormField>
                        )}
                    </>
                )}

                {/* ---- NONE fields ---- */}
                {isNone && (
                    <>
                        <Alert type="warning">
                            <strong>No authentication</strong> — the agent will connect to this
                            server without credentials. Only use this for trusted, read-only
                            endpoints (e.g., public documentation servers like the AWS Knowledge MCP
                            Server, weather data, or package registries). Do not register
                            unauthenticated servers that have write access to databases, cloud
                            resources, or internal APIs.
                        </Alert>

                        <FormField
                            label="Endpoint URL"
                            description="Streamable HTTP endpoint (must start with https://)"
                            errorText={
                                url.length > 0 && !url.startsWith("https://")
                                    ? "URL must start with https://"
                                    : undefined
                            }
                        >
                            <Input
                                value={url}
                                onChange={({ detail }) => setUrl(detail.value)}
                                placeholder="https://knowledge-mcp.global.api.aws"
                            />
                        </FormField>
                    </>
                )}

                <FormField
                    label="Description"
                    description="Optional description of the server's capabilities"
                >
                    <Textarea
                        value={description}
                        onChange={({ detail }) => setDescription(detail.value)}
                        placeholder="Provides weather data tools..."
                        rows={2}
                    />
                </FormField>
            </SpaceBetween>
        </Modal>
    );
}
