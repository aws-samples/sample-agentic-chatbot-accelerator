// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { useEffect, useState } from "react";

import {
    Box,
    Button,
    CodeEditor,
    Container,
    CopyToClipboard,
    FileUpload,
    FileUploadProps,
    Flashbar,
    Input,
    Modal,
    SpaceBetween,
} from "@cloudscape-design/components";
import { CodeEditorProps } from "@cloudscape-design/components/code-editor";
import { Mode } from "@cloudscape-design/global-styles";

import { BaseConfig, ConfigType, OperationStatus } from "./types";

import { useTranslation } from "react-i18next";
import { AdminOpsResult, ResponseStatus } from "../../../API";

import { StorageHelper } from "../../../common/helpers/storage-helper";
import { aceLoader } from "./ace";

const codeeditor_i18nStrings = {
    loadingState: "Loading code editor",
    errorState: "There was an error loading the code editor.",
    errorStateRecovery: "Retry",

    editorGroupAriaLabel: "Code editor",
    statusBarGroupAriaLabel: "Status bar",

    cursorPosition: (row: number, column: number) => `Ln ${row}, Col ${column}`,
    errorsTab: "Errors",
    warningsTab: "Warnings",
    preferencesButtonAriaLabel: "Preferences",

    paneCloseButtonAriaLabel: "Close",

    preferencesModalHeader: "Preferences",
    preferencesModalCancel: "Cancel",
    preferencesModalConfirm: "Confirm",
    preferencesModalWrapLines: "Wrap lines",
    preferencesModalTheme: "Theme",
    preferencesModalLightThemes: "Light themes",
    preferencesModalDarkThemes: "Dark themes",
};

interface ConfigurationCommonManagerProps<T extends BaseConfig> {
    configDialog: T;
    setConfigDialog: React.Dispatch<React.SetStateAction<T>>;
    configType: ConfigType;
    onSave: (config: T) => Promise<AdminOpsResult>;
    additionalControls?: React.ReactNode;
    nameRequired?: boolean;
}

export function ConfigurationCommonManager<T extends BaseConfig>(
    props: ConfigurationCommonManagerProps<T>,
) {
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState("");
    const [errorFileLoad, setErrorFileLoad] = useState("");
    const [status, setStatus] = useState<OperationStatus | undefined>(undefined);
    const { t } = useTranslation("ACA");

    const [preferences, setPreferences] = useState<CodeEditorProps.Preferences>({
        theme: StorageHelper.getTheme() === Mode.Light ? "cloud_editor" : "cloud_editor_dark",
        wrapLines: true,
    });

    const reset = () => {
        setError("");
        setErrorFileLoad("");
        setStatus(undefined);
    };

    // Add an effect to listen for theme changes
    useEffect(() => {
        const handleThemeChange = (e: CustomEvent<Mode>) => {
            setPreferences((prev) => ({
                ...prev,
                theme: e.detail === Mode.Light ? "cloud_editor" : "cloud_editor_dark",
            }));
        };

        window.addEventListener("themeChange", handleThemeChange as EventListener);

        return () => {
            window.removeEventListener("themeChange", handleThemeChange as EventListener);
        };
    }, []);

    const [ace, setAce] = useState(undefined);

    useEffect(() => {
        aceLoader
            .load()
            .then((aceEditor) => {
                if (aceEditor !== null) {
                    setAce(aceEditor);
                }
            })
            .catch((error: Error) => {
                console.error("Failed to load Ace editor:", error);
            });
    }, []);

    const formatJson = () => {
        try {
            const jsonData = JSON.parse(props.configDialog.value as string);
            const jsonString = JSON.stringify(jsonData, null, 4);
            props.setConfigDialog((prev) => ({
                ...prev,
                value: jsonString,
            }));
            reset();
        } catch (err) {
            setError("Invalid JSON file format");
            setStatus("failed");
        }
    };

    const handleFileUpload: FileUploadProps["onChange"] = ({ detail }) => {
        reset();
        const [uploadedFile] = detail.value;

        if (uploadedFile) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const jsonData = JSON.parse(e.target?.result as string);
                    const jsonString = JSON.stringify(jsonData, null, 4);
                    props.setConfigDialog((previousConfigDialog) => ({
                        ...previousConfigDialog,
                        value: jsonString,
                    }));
                    setFile(uploadedFile);
                } catch (err) {
                    setErrorFileLoad("Invalid JSON file format");
                    setFile(null);
                }
            };
            reader.readAsText(uploadedFile);
        }
    };

    const saveConfiguration = async () => {
        if (!props.configDialog.id || !props.configDialog.value) return;

        try {
            setStatus("in-progress");
            const response = await props.onSave(props.configDialog);

            switch (response.status) {
                case ResponseStatus.SUCCESSFUL:
                    setStatus("success");
                    setTimeout(() => {
                        props.setConfigDialog((prev) => ({
                            ...prev,
                            visible: false,
                        }));
                        reset();
                    }, 1000); // 1 second
                    break;
                case ResponseStatus.INVALID_CONFIG:
                    setStatus("failed");
                    setError(`Invalid ${props.configType} configuration`);
                    break;
                case ResponseStatus.INVALID_NAME:
                    setStatus("failed");
                    setError(`${props.configType} exists already`);
                    break;
                case ResponseStatus.SERVICE_ERROR:
                    setStatus("failed");
                    setError(
                        "A service error occurred. Please contact support if the issue persists.",
                    );
                    break;
                default:
                    setStatus("failed");
                    setError(
                        "An unexpected error occurred. Please try again or contact support if the issue persists.",
                    );
            }

            if (response.status === ResponseStatus.SUCCESSFUL) {
            }
        } catch (err) {
            console.error("Save error:", err);
            setError("An unexpected error occurred while saving.");
            setStatus("failed");
        }
    };

    const cancelChanges = () => {
        props.setConfigDialog((previousConfigDialog) => ({
            ...previousConfigDialog,
            id: "",
            value: "",
            visible: false,
        }));
        reset();
    };

    return (
        <Modal
            onDismiss={() => cancelChanges()}
            visible={props.configDialog.visible}
            footer={
                <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="link" onClick={cancelChanges}>
                            {t("CHATBOT.CONFIGURATION.CANCEL_BUTTON")}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={saveConfiguration}
                            disabled={!props.configDialog.id || !props.configDialog.value}
                        >
                            {props.configType === "Metadata"
                                ? "Update"
                                : t("CHATBOT.CONFIGURATION.SAVE_BUTTON")}
                        </Button>
                    </SpaceBetween>
                </Box>
            }
            header={`${props.configType} Configuration`}
        >
            <>
                {status && (
                    <Flashbar
                        items={[
                            {
                                type: status === "failed" ? "error" : "success",
                                content:
                                    status === "failed"
                                        ? error
                                        : status === "in-progress"
                                          ? `${props.configType === "Metadata" ? "Update" : "Creation"} of ${props.configType} in progress...`
                                          : "Successful",
                                loading: status === "in-progress",
                                id: `message-${status}`,
                            },
                        ]}
                    />
                )}
                <Container header={`${props.configType} Manager`}>
                    <SpaceBetween size="m">
                        {props.additionalControls}

                        {props.nameRequired !== false && (
                            <Input
                                value={props.configDialog.id}
                                onChange={({ detail }) =>
                                    props.setConfigDialog((prev) => ({
                                        ...prev,
                                        id: detail.value,
                                    }))
                                }
                                placeholder={`Enter ${props.configType} name`}
                            />
                        )}
                        <CodeEditor
                            ace={ace}
                            value={props.configDialog.value}
                            language="json"
                            preferences={preferences}
                            onPreferencesChange={(event) => setPreferences(event.detail)}
                            i18nStrings={codeeditor_i18nStrings}
                            themes={{ light: ["cloud_editor"], dark: ["cloud_editor_dark"] }}
                            onChange={({ detail }) =>
                                props.setConfigDialog((prev) => ({
                                    ...prev,
                                    value: detail.value,
                                }))
                            }
                        />

                        <SpaceBetween direction="vertical" size="s" alignItems="end">
                            <SpaceBetween direction="horizontal" size="s" alignItems="end">
                                <Button iconName="gen-ai" onClick={formatJson}>
                                    Format
                                </Button>
                                <CopyToClipboard
                                    copyButtonText="Copy"
                                    copyErrorText="Failed"
                                    copySuccessText="Configuration Copied"
                                    textToCopy={props.configDialog.value}
                                />
                            </SpaceBetween>
                        </SpaceBetween>
                        <FileUpload
                            onChange={handleFileUpload}
                            value={file ? [file] : []}
                            i18nStrings={{
                                uploadButtonText: (e) => (e ? "Choose files" : "Choose file"),
                                dropzoneText: (e) =>
                                    e ? "Drop files to upload" : "Drop file to upload",
                                removeFileAriaLabel: (e) => `Remove file ${e + 1}`,
                                limitShowFewer: "Show fewer files",
                                limitShowMore: "Show more files",
                                errorIconAriaLabel: "Error",
                                warningIconAriaLabel: "Warning",
                            }}
                            accept=".json"
                            constraintText="Only JSON files accepted"
                            errorText={errorFileLoad}
                            showFileLastModified
                            showFileSize
                            showFileThumbnail
                        />
                    </SpaceBetween>
                </Container>
            </>
        </Modal>
    );
}
