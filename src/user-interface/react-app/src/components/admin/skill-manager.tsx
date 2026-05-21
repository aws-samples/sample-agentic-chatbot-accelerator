// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
    Alert,
    Box,
    Button,
    FormField,
    Header,
    Input,
    Modal,
    SpaceBetween,
    Table,
    Textarea,
} from "@cloudscape-design/components";

import {
    createSkill as createSkillMut,
    deleteSkill as deleteSkillMut,
    updateSkill as updateSkillMut,
} from "../../graphql/mutations";
import {
    getSkillContent as getSkillContentQuery,
    listSkills as listSkillsQuery,
} from "../../graphql/queries";

interface Skill {
    name: string;
    description: string;
    s3Key: string;
    lastModified?: string;
}

export default function SkillManager() {
    const apiClient = useMemo(() => generateClient(), []);

    const [skills, setSkills] = useState<Skill[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Editor state
    const [editorVisible, setEditorVisible] = useState(false);
    const [editMode, setEditMode] = useState<"create" | "edit">("create");
    const [editName, setEditName] = useState("");
    const [editDescription, setEditDescription] = useState("");
    const [editContent, setEditContent] = useState("");
    const [saving, setSaving] = useState(false);

    // Delete state
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);

    const fetchSkills = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await apiClient.graphql({ query: listSkillsQuery });
            setSkills(((result.data as any)?.listSkills as Skill[]) || []);
        } catch (err: any) {
            setError(`Failed to load skills: ${err.message || err}`);
        } finally {
            setLoading(false);
        }
    }, [apiClient]);

    useEffect(() => {
        fetchSkills();
    }, [fetchSkills]);

    const handleCreate = () => {
        setEditMode("create");
        setEditName("");
        setEditDescription("");
        setEditContent("");
        setEditorVisible(true);
    };

    const handleEdit = async (skill: Skill) => {
        setEditMode("edit");
        setEditName(skill.name);
        setEditDescription(skill.description);
        setEditContent("Loading...");
        setEditorVisible(true);

        try {
            const result = await apiClient.graphql({
                query: getSkillContentQuery,
                variables: { name: skill.name },
            });
            const fullContent = (result.data as any)?.getSkillContent || "";
            // Strip frontmatter to get just the body
            const bodyMatch = fullContent.match(/^---\s*\n.*?\n---\s*\n(.*)/s);
            setEditContent(bodyMatch ? bodyMatch[1].trim() : fullContent);
        } catch (err: any) {
            setEditContent(`Error loading content: ${err.message || err}`);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            if (editMode === "create") {
                await apiClient.graphql({
                    query: createSkillMut,
                    variables: {
                        name: editName,
                        description: editDescription,
                        content: editContent,
                    },
                });
            } else {
                await apiClient.graphql({
                    query: updateSkillMut,
                    variables: {
                        name: editName,
                        description: editDescription,
                        content: editContent,
                    },
                });
            }
            setEditorVisible(false);
            await fetchSkills();
        } catch (err: any) {
            setError(`Failed to save skill: ${err.message || err}`);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        setError(null);
        try {
            await apiClient.graphql({
                query: deleteSkillMut,
                variables: { name: deleteTarget },
            });
            setDeleteTarget(null);
            await fetchSkills();
        } catch (err: any) {
            setError(`Failed to delete skill: ${err.message || err}`);
        } finally {
            setDeleting(false);
        }
    };

    const isFormValid =
        editName.trim() !== "" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(editName) &&
        editDescription.trim() !== "" &&
        editContent.trim() !== "";

    return (
        <>
            {/* Main skills list */}
            <SpaceBetween direction="vertical" size="m">
                {error && (
                    <Alert type="error" dismissible onDismiss={() => setError(null)}>
                        {error}
                    </Alert>
                )}

                <Table
                    items={skills}
                    loading={loading}
                    loadingText="Loading skills..."
                    header={
                        <Header
                            variant="h2"
                            actions={
                                <SpaceBetween direction="horizontal" size="xs">
                                    <Button iconName="refresh" onClick={fetchSkills}>
                                        Refresh
                                    </Button>
                                    <Button
                                        iconName="add-plus"
                                        variant="primary"
                                        onClick={handleCreate}
                                    >
                                        Create Skill
                                    </Button>
                                </SpaceBetween>
                            }
                            description="Manage skill instruction packages that agents can activate on-demand"
                        >
                            Skills
                        </Header>
                    }
                    empty={
                        <Box textAlign="center" color="text-body-secondary" padding="l">
                            No skills yet. Click &quot;Create Skill&quot; to add your first
                            skill.
                        </Box>
                    }
                    columnDefinitions={[
                        {
                            id: "name",
                            header: "Name",
                            cell: (item) => item.name,
                            sortingField: "name",
                            width: 200,
                        },
                        {
                            id: "description",
                            header: "Description",
                            cell: (item) =>
                                item.description.length > 100
                                    ? item.description.substring(0, 100) + "..."
                                    : item.description,
                        },
                        {
                            id: "lastModified",
                            header: "Last Modified",
                            cell: (item) =>
                                item.lastModified
                                    ? new Date(item.lastModified).toLocaleDateString()
                                    : "—",
                            width: 140,
                        },
                        {
                            id: "actions",
                            header: "Actions",
                            cell: (item) => (
                                <SpaceBetween direction="horizontal" size="xs">
                                    <Button
                                        variant="inline-link"
                                        onClick={() => handleEdit(item)}
                                    >
                                        Edit
                                    </Button>
                                    <Button
                                        variant="inline-link"
                                        onClick={() => setDeleteTarget(item.name)}
                                    >
                                        Delete
                                    </Button>
                                </SpaceBetween>
                            ),
                            width: 160,
                        },
                    ]}
                />
            </SpaceBetween>

            {/* Skill editor modal */}
            <Modal
                visible={editorVisible}
                onDismiss={() => setEditorVisible(false)}
                header={editMode === "create" ? "Create Skill" : `Edit Skill: ${editName}`}
                size="large"
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            <Button variant="link" onClick={() => setEditorVisible(false)}>
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleSave}
                                loading={saving}
                                disabled={!isFormValid}
                            >
                                {editMode === "create" ? "Create" : "Save"}
                            </Button>
                        </SpaceBetween>
                    </Box>
                }
            >
                <SpaceBetween direction="vertical" size="l">
                    <FormField
                        label="Skill Name"
                        description="Unique identifier (letters, digits, hyphens, underscores)"
                        errorText={
                            editName && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(editName)
                                ? "Must start with a letter/digit, max 64 chars, only letters/digits/hyphens/underscores"
                                : undefined
                        }
                    >
                        <Input
                            value={editName}
                            onChange={({ detail }) => setEditName(detail.value)}
                            placeholder="e.g. analog-alarms"
                            disabled={editMode === "edit"}
                        />
                    </FormField>

                    <FormField
                        label="Description"
                        description="Short description shown to the agent as skill metadata"
                    >
                        <Textarea
                            value={editDescription}
                            onChange={({ detail }) => setEditDescription(detail.value)}
                            placeholder="Mapping rules for alarm limits and enables..."
                            rows={2}
                        />
                    </FormField>

                    <FormField
                        label="Instructions (Markdown)"
                        description="The full skill instructions loaded on-demand by the agent. Use markdown formatting."
                    >
                        <Textarea
                            value={editContent}
                            onChange={({ detail }) => setEditContent(detail.value)}
                            placeholder="# Analog Alarm Mapping\n\n## Fields Covered\n..."
                            rows={18}
                        />
                    </FormField>
                </SpaceBetween>
            </Modal>

            {/* Delete confirmation */}
            <Modal
                visible={deleteTarget !== null}
                onDismiss={() => setDeleteTarget(null)}
                header="Delete Skill"
                footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="xs">
                            <Button variant="link" onClick={() => setDeleteTarget(null)}>
                                Cancel
                            </Button>
                            <Button variant="primary" onClick={handleDelete} loading={deleting}>
                                Delete
                            </Button>
                        </SpaceBetween>
                    </Box>
                }
            >
                <Box>
                    Are you sure you want to delete the skill <strong>{deleteTarget}</strong>? This
                    action cannot be undone.
                </Box>
            </Modal>
        </>
    );
}
