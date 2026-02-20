/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
import { Mode } from "@cloudscape-design/global-styles";
import { StorageHelper } from "../../../common/helpers/storage-helper";

import { Dispatch, SetStateAction } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import Prism from "react-syntax-highlighter/dist/cjs/prism";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import styles from "../../../styles/chat.module.scss";
import "../../../styles/prism.scss";

type CustomComponents = Components & {};

export interface MarkdownContentProps {
    content: string;
    setAnnex?: Dispatch<SetStateAction<React.ReactElement | null>> | null;
}

export default function MarkdownContent(props: MarkdownContentProps) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={
                {
                    // Custom rendering for code blocks
                    code: ({ node, inline, className, children, ...props }: any) => {
                        const match = /language-(\w+)/.exec(className || "");
                        return !inline && match ? (
                            <Prism
                                style={StorageHelper.getTheme() === Mode.Dark ? vscDarkPlus : vs}
                                language={match[1]}
                                PreTag="div"
                                {...props}
                            >
                                {String(children).replace(/\n$/, "")}
                            </Prism>
                        ) : (
                            <code className={className} {...props}>
                                {children}
                            </code>
                        );
                    },
                    // Custom table rendering
                    table: ({ children }) => {
                        return (
                            <div className={styles.markdownTableContainer}>
                                <table className={styles.markdownTable}>{children}</table>
                            </div>
                        );
                    },
                    // Custom table header cell rendering
                    th: ({ children }) => {
                        return <th className={styles.markdownTh}>{children}</th>;
                    },
                    // Custom table cell rendering
                    td: ({ children }) => {
                        return <td className={styles.markdownTd}>{children}</td>;
                    },
                    // Preserve sup tags
                    sup: ({ children }) => {
                        return <sup className={styles.markdownSup}>{children}</sup>;
                    },
                    // Custom paragraph rendering
                    p: ({ children }) => {
                        return <p className={styles.markdownParagraph}>{children}</p>;
                    },
                } as CustomComponents
            }
        >
            {props.content}
        </ReactMarkdown>
    );
}
