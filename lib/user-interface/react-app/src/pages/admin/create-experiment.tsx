// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import {
    Alert,
    Box,
    BreadcrumbGroup,
    Button,
    Container,
    Form,
    FormField,
    Header,
    Input,
    Select,
    SpaceBetween,
    Textarea,
} from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import { AppContext } from "../../common/app-context";
import BaseAppLayout from "../../components/base-app-layout";
import * as mutations from "../../graphql/mutations";

export default function CreateExperimentPage() {
    const appConfig = useContext(AppContext);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    // Auto-generation fields
    const [context, setContext] = useState("");
    const [taskDescription, setTaskDescription] = useState("");
    const [numCases, setNumCases] = useState("10");
    const [numTopics, setNumTopics] = useState("3");
    const [modelId, setModelId] = useState("");
    const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);

    useEffect(() => {
        const experimentsConfig = appConfig?.experimentsConfig;
        if (experimentsConfig?.supportedModels && appConfig) {
            const models = Object.entries(experimentsConfig.supportedModels).map(([label, value]) => {
                const modelValue = (value as string).replace(
                    "[REGION-PREFIX]",
                    appConfig.aws_project_region.split("-")[0],
                );
                return { label, value: modelValue };
            });
            setModelOptions(models);
            if (models.length > 0) {
                setModelId(models[0].value);
            }
        }
    }, [appConfig]);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const navigate = useNavigate();
    const onFollow = useOnFollow();
    const apiClient = generateClient();

    const validateForm = (): boolean => {
        if (!name) {
            setError("Please provide experiment name");
            return false;
        }

        if (!modelId) {
            setError("Please provide a model ID");
            return false;
        }

        if (!context || !taskDescription) {
            setError("Please provide context and task description for generation");
            return false;
        }
        const cases = parseInt(numCases);
        const topics = parseInt(numTopics);
        if (isNaN(cases) || cases < 1 || cases > 100) {
            setError("Number of cases must be between 1 and 100");
            return false;
        }
        if (isNaN(topics) || topics < 1 || topics > 10) {
            setError("Number of topics must be between 1 and 10");
            return false;
        }

        return true;
    };

    const handleSubmit = async () => {
        if (!validateForm()) {
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const experimentData: any = {
                name,
                description,
                modelId,
                generationConfig: JSON.stringify({
                    context,
                    taskDescription,
                    numCases: parseInt(numCases),
                    numTopics: parseInt(numTopics),
                }),
            };

            await apiClient.graphql({
                query: mutations.createExperiment,
                variables: experimentData,
            });
            navigate("/experiments");
        } catch (err) {
            console.error("Error creating experiment:", err);
            setError("Failed to create experiment");
        } finally {
            setLoading(false);
        }
    };

    return (
        <BaseAppLayout
            contentType="form"
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        {
                            text: CHATBOT_NAME,
                            href: "/",
                        },
                        {
                            text: "Experiments",
                            href: "/experiments",
                        },
                        {
                            text: "Create",
                            href: "/experiments/create",
                        },
                    ]}
                />
            }
            content={
                <Form
                    actions={
                        <SpaceBetween direction="horizontal" size="xs">
                            <Button
                                variant="link"
                                onClick={() => navigate("/experiments")}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                loading={loading}
                                onClick={handleSubmit}
                            >
                                Create and Run Experiment
                            </Button>
                        </SpaceBetween>
                    }
                    header={<Header variant="h1">Create Experiment</Header>}
                >
                    <SpaceBetween size="l">
                        {error && (
                            <Alert type="error" dismissible onDismiss={() => setError(null)}>
                                {error}
                            </Alert>
                        )}

                        <Container header={<Header variant="h2">Basic Information</Header>}>
                            <SpaceBetween size="l">
                                <FormField label="Name" description="A descriptive name for your experiment">
                                    <Input
                                        value={name}
                                        onChange={({ detail }) => setName(detail.value)}
                                        placeholder="Enter a name for this synthetic data generation run"
                                    />
                                </FormField>

                                <FormField label="Description" description="Optional description">
                                    <Textarea
                                        value={description}
                                        onChange={({ detail }) => setDescription(detail.value)}
                                        placeholder="Briefly describe the purpose of this synthetic data generation"
                                    />
                                </FormField>
                            </SpaceBetween>
                        </Container>

                        <Container header={<Header variant="h2">Test Data</Header>}>
                            <SpaceBetween size="l">
                                <FormField
                                    label="Context"
                                    description="Describe your agent system, tools, and capabilities"
                                >
                                    <Textarea
                                        value={context}
                                        onChange={({ detail }) => setContext(detail.value)}
                                        placeholder="Describe your agent system, its tools, and capabilities to guide synthetic data generation"
                                        rows={6}
                                    />
                                </FormField>

                                <FormField
                                    label="Task Description"
                                    description="What tasks should the test cases cover?"
                                >
                                    <Textarea
                                        value={taskDescription}
                                        onChange={({ detail }) => setTaskDescription(detail.value)}
                                        placeholder="Describe the types of tasks the synthetic test cases should cover"
                                        rows={3}
                                    />
                                </FormField>

                                <FormField
                                    label="Number of Test Cases"
                                    description="How many test cases to generate (1-100)"
                                >
                                    <Input
                                        value={numCases}
                                        onChange={({ detail }) => setNumCases(detail.value)}
                                        type="number"
                                        inputMode="numeric"
                                    />
                                </FormField>

                                <FormField
                                    label="Number of Topics"
                                    description="How many different topic categories (1-10)"
                                >
                                    <Input
                                        value={numTopics}
                                        onChange={({ detail }) => setNumTopics(detail.value)}
                                        type="number"
                                        inputMode="numeric"
                                    />
                                </FormField>
                            </SpaceBetween>
                        </Container>

                        <Container header={<Header variant="h2">Model</Header>}>
                            <FormField
                                label="Model ID"
                                description="Bedrock model ID to use for generation"
                                errorText={modelId === "" ? "Model is required" : ""}
                            >
                                <Select
                                    selectedOption={modelOptions.find(opt => opt.value === modelId) || null}
                                    onChange={({ detail }) =>
                                        setModelId(detail.selectedOption?.value || modelId)
                                    }
                                    options={modelOptions}
                                    placeholder="Select a model..."
                                />
                            </FormField>
                        </Container>

                        <Box>
                            <Alert type="info">
                                The experiment will automatically run after creation to generate synthetic test cases using AI.
                            </Alert>
                        </Box>
                    </SpaceBetween>
                </Form>
            }
        />
    );
}
