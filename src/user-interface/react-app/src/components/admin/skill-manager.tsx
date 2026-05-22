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
    Select,
    SpaceBetween,
    Table,
    Tabs,
    Textarea,
} from "@cloudscape-design/components";

import {
    createSkill as createSkillMut,
    deleteSkill as deleteSkillMut,
    deleteSkillResource as deleteSkillResourceMut,
    updateSkill as updateSkillMut,
    uploadSkillResource as uploadSkillResourceMut,
} from "../../graphql/mutations";
import {
    getSkillContent as getSkillContentQuery,
    listSkillResources as listSkillResourcesQuery,
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
                size="max"
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

                    <Tabs
                        tabs={[
                            {
                                id: "instructions",
                                label: "Instructions",
                                content: (
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
                                ),
                            },
                            {
                                id: "resources",
                                label: "Resources",
                                disabled: editMode === "create",
                                disabledReason: "Save the skill first, then re-open it to manage resource files",
                                content: (
                                    <SkillResourceManager
                                        skillName={editName}
                                        apiClient={apiClient}
                                    />
                                ),
                            },
                        ]}
                    />
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

// ── Resource Manager Sub-Component ────────────────────────────────────
// Manages resource files (scripts/, references/, assets/) within a skill directory.

interface SkillResource {
    path: string;
    size: number;
    lastModified?: string;
}

function SkillResourceManager({
    skillName,
    apiClient,
}: {
    skillName: string;
    apiClient: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
    const [resources, setResources] = useState<SkillResource[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Upload form state
    const [uploadDir, setUploadDir] = useState<string>("scripts/");
    const [uploadFilename, setUploadFilename] = useState("");
    const [uploadContent, setUploadContent] = useState("");
    const [uploading, setUploading] = useState(false);

    const fetchResources = useCallback(async () => {
        if (!skillName) return;
        setLoading(true);
        setError(null);
        try {
            const result = await apiClient.graphql({
                query: listSkillResourcesQuery,
                variables: { name: skillName },
            });
            setResources(((result.data as any)?.listSkillResources as SkillResource[]) || []);
        } catch (err: any) {
            setError(`Failed to load resources: ${err.message || err}`);
        } finally {
            setLoading(false);
        }
    }, [apiClient, skillName]);

    useEffect(() => {
        fetchResources();
    }, [fetchResources]);

    const handleUpload = async () => {
        if (!uploadFilename.trim() || !uploadContent.trim()) return;
        setUploading(true);
        setError(null);
        try {
            const path = `${uploadDir}${uploadFilename.trim()}`;
            await apiClient.graphql({
                query: uploadSkillResourceMut,
                variables: { name: skillName, path, content: uploadContent },
            });
            setUploadFilename("");
            setUploadContent("");
            await fetchResources();
        } catch (err: any) {
            setError(`Failed to upload resource: ${err.message || err}`);
        } finally {
            setUploading(false);
        }
    };

    const handleDeleteResource = async (path: string) => {
        setError(null);
        try {
            await apiClient.graphql({
                query: deleteSkillResourceMut,
                variables: { name: skillName, path },
            });
            await fetchResources();
        } catch (err: any) {
            setError(`Failed to delete resource: ${err.message || err}`);
        }
    };

    const formatBytes = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    };

    return (
        <SpaceBetween direction="vertical" size="m">
            {error && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>
                    {error}
                </Alert>
            )}

            <Table
                items={resources}
                loading={loading}
                loadingText="Loading resources..."
                header={
                    <Header
                        variant="h3"
                        description="Resource files available to the agent when this skill is activated (max 20 files, 1MB each)"
                        actions={
                            <Button iconName="refresh" onClick={fetchResources}>
                                Refresh
                            </Button>
                        }
                    >
                        Resource Files ({resources.length}/20)
                    </Header>
                }
                empty={
                    <Box textAlign="center" color="text-body-secondary" padding="s">
                        No resource files. Upload scripts, references, or assets below.
                    </Box>
                }
                columnDefinitions={[
                    {
                        id: "path",
                        header: "Path",
                        cell: (item) => (
                            <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                                {item.path}
                            </span>
                        ),
                    },
                    {
                        id: "size",
                        header: "Size",
                        cell: (item) => formatBytes(item.size),
                        width: 100,
                    },
                    {
                        id: "lastModified",
                        header: "Modified",
                        cell: (item) =>
                            item.lastModified
                                ? new Date(item.lastModified).toLocaleDateString()
                                : "—",
                        width: 120,
                    },
                    {
                        id: "actions",
                        header: "",
                        cell: (item) => (
                            <Button
                                variant="inline-link"
                                onClick={() => handleDeleteResource(item.path)}
                            >
                                Delete
                            </Button>
                        ),
                        width: 80,
                    },
                ]}
            />

            {/* Upload form */}
            <Header variant="h3">Upload Resource</Header>
            <SpaceBetween direction="vertical" size="s">
                <SpaceBetween direction="horizontal" size="s">
                    <FormField label="Directory">
                        <Select
                            selectedOption={{ label: uploadDir, value: uploadDir }}
                            onChange={({ detail }) =>
                                setUploadDir(detail.selectedOption?.value || "scripts/")
                            }
                            options={[
                                { value: "scripts/", label: "scripts/" },
                                { value: "references/", label: "references/" },
                                { value: "assets/", label: "assets/" },
                            ]}
                        />
                    </FormField>
                    <FormField label="Filename">
                        <Input
                            value={uploadFilename}
                            onChange={({ detail }) => setUploadFilename(detail.value)}
                            placeholder={
                                uploadDir === "scripts/"
                                    ? "e.g. extract.py"
                                    : uploadDir === "references/"
                                      ? "e.g. API-reference.md"
                                      : "e.g. mapping-template.json"
                            }
                        />
                    </FormField>
                </SpaceBetween>
                <FormField label="Content">
                    <Textarea
                        value={uploadContent}
                        onChange={({ detail }) => setUploadContent(detail.value)}
                        placeholder="Paste file content here..."
                        rows={10}
                    />
                </FormField>
                <Button
                    variant="primary"
                    onClick={handleUpload}
                    loading={uploading}
                    disabled={!uploadFilename.trim() || !uploadContent.trim()}
                >
                    Upload
                </Button>
            </SpaceBetween>
        </SpaceBetween>
    );
}
