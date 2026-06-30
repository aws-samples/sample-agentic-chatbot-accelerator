// -----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// This is AWS Content subject to the terms of the Customer Agreement
//
// -----------------------------------------------------------------------
import { BreadcrumbGroup, Spinner } from "@cloudscape-design/components";
import { generateClient } from "aws-amplify/api";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { CHATBOT_NAME } from "../../common/constants";
import useOnFollow from "../../common/hooks/use-on-follow";
import { EvaluatorType, TestCase } from "../../common/types";
import BaseAppLayout from "../../components/base-app-layout";
import CreateEvaluatorWizard, {
    EvaluatorConfig,
    EvaluatorConfiguration,
} from "../../components/wizard/create-evaluator-wizard";
import { updateEvaluator as updateEvaluatorMutation } from "../../graphql/mutations";
import {
    getEvaluator as getEvaluatorQuery,
    getEvaluatorTestCases as getEvaluatorTestCasesQuery,
} from "../../graphql/queries";

// Parse the stored "evaluatorType" (comma-separated) + combined "customRubric"
// (sections like "[OutputEvaluator]\n<rubric>\n\n---\n\n[...]") back into the
// per-evaluator structure the wizard expects.
function parseEvaluators(
    evaluatorType?: string | null,
    customRubric?: string | null,
): EvaluatorConfig[] {
    const types = (evaluatorType || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

    // Build a map of type -> rubric from the combined rubric string.
    const rubricByType: Record<string, string> = {};
    if (customRubric) {
        for (const section of customRubric.split("\n\n---\n\n")) {
            const match = section.match(/^\[([^\]]+)\]\n([\s\S]*)$/);
            if (match) {
                rubricByType[match[1].trim()] = match[2].trim();
            }
        }
    }

    return types.map((type, i) => ({
        id: `${type}-${i}`,
        type: type as EvaluatorType | string,
        rubric: rubricByType[type] || undefined,
    }));
}

export default function EvaluationsEditPage() {
    const navigate = useNavigate();
    const onFollow = useOnFollow();
    const { evaluatorId } = useParams<{ evaluatorId: string }>();
    const apiClient = useMemo(() => generateClient(), []);

    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [initialConfig, setInitialConfig] = useState<EvaluatorConfiguration | null>(null);

    useEffect(() => {
        if (!evaluatorId) return;

        const load = async () => {
            setIsLoading(true);
            try {
                const [evalResult, casesResult] = await Promise.all([
                    apiClient.graphql({
                        query: getEvaluatorQuery,
                        variables: { evaluatorId },
                    }),
                    apiClient.graphql({
                        query: getEvaluatorTestCasesQuery,
                        variables: { evaluatorId },
                    }),
                ]);

                const e = evalResult.data?.getEvaluator;
                if (!e) {
                    navigate("/evaluations");
                    return;
                }

                let testCases: TestCase[] = [];
                const raw = casesResult.data?.getEvaluatorTestCases;
                if (raw) {
                    try {
                        testCases = JSON.parse(raw);
                    } catch {
                        testCases = [];
                    }
                }

                const evaluators = parseEvaluators(e.evaluatorType, e.customRubric);

                setInitialConfig({
                    name: e.name,
                    description: e.description || "",
                    agentRuntimeId: "", // resolved by name in the wizard's agent list
                    agentRuntimeName: e.agentRuntimeName || "",
                    qualifier: e.qualifier || "",
                    modelId: e.modelId || "",
                    passThreshold: e.passThreshold ?? 0.8,
                    repeatCount: e.repeatCount ?? 1,
                    evaluatorType: evaluators[0]?.type || EvaluatorType.OUTPUT,
                    customRubric: evaluators[0]?.rubric || "",
                    evaluators,
                    testCases,
                });
            } catch (error) {
                console.error("Failed to load evaluator:", error);
                navigate("/evaluations");
            } finally {
                setIsLoading(false);
            }
        };

        load();
    }, [evaluatorId, apiClient, navigate]);

    const handleSubmit = async (config: EvaluatorConfiguration) => {
        if (!evaluatorId) return;
        setIsSaving(true);
        try {
            const evaluatorTypes =
                config.evaluators?.length > 0
                    ? config.evaluators.map((e) => e.type).join(", ")
                    : config.evaluatorType || "OutputEvaluator";

            const customRubrics =
                config.evaluators?.length > 0
                    ? config.evaluators
                          .filter((e) => e.rubric)
                          .map((e) => `[${e.type}]\n${e.rubric}`)
                          .join("\n\n---\n\n")
                    : config.customRubric || "";

            await apiClient.graphql({
                query: updateEvaluatorMutation,
                variables: {
                    evaluatorId,
                    input: {
                        description: config.description || "",
                        evaluatorType: evaluatorTypes,
                        customRubric: customRubrics,
                        agentRuntimeName: config.agentRuntimeName || "",
                        qualifier: config.qualifier || "",
                        modelId: config.modelId || "",
                        passThreshold: config.passThreshold ?? 0.8,
                        repeatCount: config.repeatCount ?? 1,
                        testCases: JSON.stringify(config.testCases || []),
                    },
                },
            });

            navigate("/evaluations");
        } catch (error) {
            console.error("Failed to update evaluator:", error);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <BaseAppLayout
            contentType="wizard"
            breadcrumbs={
                <BreadcrumbGroup
                    onFollow={onFollow}
                    items={[
                        { text: CHATBOT_NAME, href: "/" },
                        { text: "Evaluations", href: "/evaluations" },
                        { text: "Edit Evaluator", href: `/evaluations/edit/${evaluatorId}` },
                    ]}
                />
            }
            content={
                isLoading || !initialConfig ? (
                    <Spinner size="large" />
                ) : (
                    <CreateEvaluatorWizard
                        onSubmit={handleSubmit}
                        onCancel={() => navigate("/evaluations")}
                        isCreating={isSaving}
                        isEditMode={true}
                        initialConfig={initialConfig}
                    />
                )
            }
        />
    );
}
