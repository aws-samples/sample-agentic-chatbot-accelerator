// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------
import { BreadcrumbGroup } from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import BaseAppLayout from "../../components/base-app-layout";
import CreateEvaluatorWizard, { EvaluatorConfiguration } from "../../components/wizard/create-evaluator-wizard";
import { createEvaluator as createEvaluatorMutation } from "../../graphql/mutations";

export default function EvaluationsWizardPage() {
    const navigate = useNavigate();
    const onFollow = useOnFollow();
    const [isCreating, setIsCreating] = useState(false);
    const apiClient = useMemo(() => generateClient(), []);

    const handleSubmit = async (config: EvaluatorConfiguration) => {
        setIsCreating(true);

        try {
            // Join multiple evaluator types with commas
            const evaluatorTypes = config.evaluators?.length > 0
                ? config.evaluators.map(e => e.type).join(", ")
                : config.evaluatorType || "OutputEvaluator";

            // Combine rubrics from all evaluators
            const customRubrics = config.evaluators?.length > 0
                ? config.evaluators
                    .filter(e => e.rubric)
                    .map(e => `[${e.type}]\n${e.rubric}`)
                    .join("\n\n---\n\n")
                : config.customRubric || "";

            await apiClient.graphql({
                query: createEvaluatorMutation,
                variables: {
                    input: {
                        name: config.name || "",
                        description: config.description || "",
                        evaluatorType: evaluatorTypes,
                        customRubric: customRubrics,
                        agentRuntimeName: config.agentRuntimeName || "",
                        qualifier: config.qualifier || "",
                        modelId: config.modelId || "",
                        passThreshold: config.passThreshold ?? 0.8,
                        testCases: JSON.stringify(config.testCases || []),
                    }
                }
            });

            // Navigate back to evaluations list
            navigate("/evaluations");
        } catch (error) {
            console.error("Failed to create evaluator:", error);
        } finally {
            setIsCreating(false);
        }
    };

    const handleCancel = () => {
        navigate("/evaluations");
    };

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
                            text: "Evaluations",
                            href: "/evaluations",
                        },
                        {
                            text: "Create Evaluator",
                            href: "/evaluations/create",
                        },
                    ]}
                />
            }
            content={
                <CreateEvaluatorWizard
                    onSubmit={handleSubmit}
                    onCancel={handleCancel}
                    isCreating={isCreating}
                />
            }
        />
    );
}
