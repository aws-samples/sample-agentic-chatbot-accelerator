/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    Utility methods for interacting with the browser's local storage
*/
import { Mode, applyMode } from "@cloudscape-design/global-styles";
import { NavigationPanelState } from "../types";

const PREFIX = "aca";
const THEME_STORAGE_NAME = `${PREFIX}-theme`;
const NAVIGATION_PANEL_STATE_STORAGE_NAME = `${PREFIX}-navigation-panel-state`;
const USER_NAME = `${PREFIX}-userName`;
const USER_ID = `${PREFIX}-userId`;
const INITIALS = `${PREFIX}-userInitials`;

export abstract class StorageHelper {
    /**
     * Retrieve the current theme from the local storage. If theme is not defined, Light mode is used.
     *
     * @returns website (dark or light)
     */
    static getTheme() {
        const value = localStorage.getItem(THEME_STORAGE_NAME) ?? Mode.Light;
        return value === Mode.Dark ? Mode.Dark : Mode.Light;
    }

    /**
     * Sets the specified theme in the local storage, applies it to the document and updates CSS
     *
     * @param theme Visual Mode from Cloudscape
     * @returns the theme
     */
    static applyTheme(theme: Mode) {
        localStorage.setItem(THEME_STORAGE_NAME, theme);
        applyMode(theme);

        document.documentElement.style.setProperty(
            "--app-color-scheme",
            theme === Mode.Dark ? "dark" : "light",
        );

        window.dispatchEvent(new CustomEvent("themeChange", { detail: theme }));

        return theme;
    }

    /**
     * Get navigation panel from the local storage
     *
     * @returns The navigation panel
     */
    static getNavigationPanelState(): NavigationPanelState {
        const value =
            localStorage.getItem(NAVIGATION_PANEL_STATE_STORAGE_NAME) ??
            JSON.stringify({ collapsed: true });
        let state: NavigationPanelState | null = null;
        try {
            state = JSON.parse(value);
        } catch {
            state = {};
        }
        return state ?? {};
    }

    /**
     * Set the navigation state in local storage and returns it
     *
     * @param state An object representing the state of the navigation panel, not all properties are required (Partial)
     * @returns The updated panel state
     */
    static setNavigationPanelState(state: Partial<NavigationPanelState>) {
        const currentState = this.getNavigationPanelState();
        const newState = { ...currentState, ...state };
        const stateStr = JSON.stringify(newState);
        localStorage.setItem(NAVIGATION_PANEL_STATE_STORAGE_NAME, stateStr);

        return newState;
    }

    static getUserName() {
        const value = localStorage.getItem(USER_NAME) ?? "John Doe";
        return value;
    }

    static setUserName(value: string) {
        localStorage.setItem(USER_NAME, value);
    }

    static setUserId(value: string) {
        localStorage.setItem(USER_ID, value);
    }

    static getUserId() {
        const value = localStorage.getItem(USER_ID) ?? "??";
        return value;
    }
    static getUserInitials() {
        const value = localStorage.getItem(INITIALS) ?? "JD";
        return value;
    }

    static setUserInitials(value: string) {
        localStorage.setItem(INITIALS, value);
    }
}
