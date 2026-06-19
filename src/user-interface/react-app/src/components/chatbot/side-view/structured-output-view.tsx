// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Box, Button, Container, Header } from "@cloudscape-design/components";
import { Mode } from "@cloudscape-design/global-styles";
import { useEffect, useState } from "react";
import { JsonView, allExpanded, collapseAllNested, darkStyles, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { StorageHelper } from "../../../common/helpers/storage-helper";

export interface StructuredOutputContentProps {
    /** Raw structured-output payload (expected to be JSON, but may be plain text). */
    raw: string;
    /** Expand all nodes by default. The inline preview collapses; the canvas expands. */
    expandAll?: boolean;
}

/**
 * Renders an agent's structured output as an interactive JSON tree, falling back
 * to monospaced text when the payload isn't valid JSON. Theme-aware so it matches
 * the rest of the Cloudscape surface in light and dark mode.
 */
export function StructuredOutputContent(props: StructuredOutputContentProps) {
    const [theme, setTheme] = useState(StorageHelper.getTheme());

    useEffect(() => {
        const handleThemeChange = (e: CustomEvent<Mode>) => setTheme(e.detail);
        window.addEventListener("themeChange", handleThemeChange as EventListener);
        return () =>
            window.removeEventListener("themeChange", handleThemeChange as EventListener);
    }, []);

    let parsed: unknown;
    try {
        parsed = JSON.parse(props.raw);
    } catch {
        // Not JSON — show the raw payload verbatim.
        return (
            <Box variant="code">
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
                    {props.raw}
                </pre>
            </Box>
        );
    }

    if (typeof parsed !== "object" || parsed === null) {
        return <Box variant="code">{String(parsed)}</Box>;
    }

    return (
        <JsonView
            data={parsed as object}
            shouldExpandNode={props.expandAll ? allExpanded : collapseAllNested}
            style={theme === Mode.Dark ? darkStyles : defaultStyles}
        />
    );
}

export interface StructuredOutputViewProps {
    raw: string;
    title: string;
    onClose: () => void;
}

/** Annex-canvas wrapper for structured output (T5 artifact preview — canvas model). */
export default function StructuredOutputView(props: StructuredOutputViewProps) {
    return (
        <div className="reference-container" style={{ height: "100%", marginLeft: "20px" }}>
            <Container
                fitHeight
                header={
                    <Header
                        actions={
                            <Button onClick={props.onClose} iconName="close" variant="icon" />
                        }
                    >
                        {props.title}
                    </Header>
                }
            >
                <StructuredOutputContent raw={props.raw} expandAll />
            </Container>
        </div>
    );
}
