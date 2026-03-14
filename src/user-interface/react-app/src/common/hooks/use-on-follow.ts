/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    React hook that handles navigation events when user clicks on link or a button
*/
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

interface NavigationDetail {
    /** a boolean indicating whether the navigation should be handled externally (e.g., opening a new browser tab). */
    external?: boolean;
    /** a string representing the URL or path to navigate to within the application. */
    href?: string;
}

export default function useOnFollow() {
    const navigate = useNavigate();

    return useCallback(
        (event: CustomEvent<NavigationDetail>): void => {
            if (event.detail.external === true || typeof event.detail.href === "undefined") {
                return;
            }

            event.preventDefault();
            navigate(event.detail.href);
        },
        [navigate],
    );
}
