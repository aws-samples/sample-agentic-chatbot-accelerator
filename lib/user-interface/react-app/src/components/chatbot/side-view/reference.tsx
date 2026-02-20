/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
import { Button, Container, Header } from "@cloudscape-design/components";
import { Mode } from "@cloudscape-design/global-styles";
import { useEffect, useState } from "react";
import { StorageHelper } from "../../../common/helpers/storage-helper";
import MarkdownContent from "./markdown-content";

/**
 * Props interface for Athena Result component
 * @interface ReferenceProps
 * @property {string} text
 * @property {() => void} onClose - Close function
 */
export interface ViewReferenceProps {
    content: string;
    title: string;
    onClose: () => void;
}

export default function ViewReference(props: ViewReferenceProps) {
    const [theme, setTheme] = useState(StorageHelper.getTheme());
    console.log("theme", theme);

    useEffect(() => {
        const handleThemeChange = (e: CustomEvent<Mode>) => {
            setTheme(e.detail);
        };

        window.addEventListener("themeChange", handleThemeChange as EventListener);

        return () => {
            window.removeEventListener("themeChange", handleThemeChange as EventListener);
        };
    }, []);

    return (
        <div className="reference-container" style={{ height: "100%", marginLeft: "20px" }}>
            <Container
                fitHeight
                header={
                    <Header
                        actions={
                            <Button
                                external={false}
                                onClick={props.onClose}
                                iconName="close"
                                variant="icon"
                            ></Button>
                        }
                    >
                        {props.title}
                    </Header>
                }
            >
                <MarkdownContent content={props.content} />
            </Container>
        </div>
    );
}
