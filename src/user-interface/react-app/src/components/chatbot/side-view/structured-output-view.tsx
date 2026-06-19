// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { Button, Container, CopyToClipboard, Header } from "@cloudscape-design/components";
import CodeView from "@cloudscape-design/code-view/code-view";
import jsonHighlight from "@cloudscape-design/code-view/highlight/json";
import { useTranslation } from "react-i18next";

export interface StructuredOutputContentProps {
    /** Raw structured-output payload (expected to be JSON, but may be plain text). */
    raw: string;
    /** Show line numbers — useful in the larger canvas view, noise in the inline card. */
    lineNumbers?: boolean;
    /** Render a copy-to-clipboard control in the CodeView actions slot. */
    copyable?: boolean;
}

/** Pretty-print JSON; leave non-JSON payloads untouched so they still render. */
function prettyPrint(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

/**
 * Renders an agent's structured output as syntax-highlighted, pretty-printed JSON
 * via Cloudscape's CodeView, matching the look of other code artifacts. Non-JSON
 * payloads fall back to the raw text (still inside CodeView, sans highlighting).
 */
export function StructuredOutputContent(props: StructuredOutputContentProps) {
    const { t } = useTranslation("ACA");
    const content = prettyPrint(props.raw);
    return (
        <CodeView
            content={content}
            highlight={jsonHighlight}
            lineNumbers={props.lineNumbers}
            wrapLines
            actions={
                props.copyable ? (
                    <CopyToClipboard
                        variant="icon"
                        textToCopy={content}
                        copyButtonText={t("CHATBOT.PLAYGROUND.ARTIFACT_COPY")}
                        copySuccessText={t("CHATBOT.PLAYGROUND.ARTIFACT_COPIED")}
                        copyErrorText={t("CHATBOT.PLAYGROUND.ARTIFACT_COPY_ERROR")}
                    />
                ) : undefined
            }
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
                <StructuredOutputContent raw={props.raw} lineNumbers copyable />
            </Container>
        </div>
    );
}
