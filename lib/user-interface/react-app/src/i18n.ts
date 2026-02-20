/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
    resources: {
        en: {
            ACA: {
                "CHATBOT.CONFIGURATION.NEW_BUTTON": "New configuration",
                "CHATBOT.CONFIGURATION.REFRESH_BUTTON": "Refresh",
                "CHATBOT.CONFIGURATION.VIEW_BUTTON": "View",
                "CHATBOT.CONFIGURATION.DELETE_BUTTON": "Delete",
                "CHATBOT.CONFIGURATION.NO_MATCH_MSG": "No matching configurations found",
                "CHATBOT.CONFIGURATION.CANCEL_BUTTON": "Cancel",
                "CHATBOT.CONFIGURATION.OK_BUTTON": "OK",
                "CHATBOT.CONFIGURATION.SAVE_BUTTON": "Create",
                "CHATBOT.CONFIGURATION.EMPTY_MSG": "No configurations",
                //
                "CHATBOT.SESSIONS.CANCEL_BUTTON": "Cancel",
                "CHATBOT.SESSIONS.OK_BUTTON": "OK",
                "CHATBOT.SESSIONS.DELETE_MSG": "Do you want to delete",
                "CHATBOT.SESSIONS.DELETE_ALL_MSG": "Delete all sessions",
                "CHATBOT.SESSIONS.PAGE_TITLE": "Session History",
                "CHATBOT.SESSIONS.EMPTY_MSG": "No sessions",
                "CHATBOT.SESSIONS.NEW_BUTTON": "New session",
                "CHATBOT.SESSIONS.REFRESH": "Refresh",
                "CHATBOT.SESSIONS.DELETE": "Delete",
                //
                "CHATBOT.PLAYGROUND.USER_GUIDE_MSG": "Agent Chat Guide",
                "CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_TITLE": "Getting Started",
                "CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_1":
                    "Select an Agent Runtime from the dropdown to connect to an AI agent",
                "CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_2":
                    "Choose an Endpoint to specify which deployment to use",
                "CHATBOT.PLAYGROUND.HELP_GETTING_STARTED_3":
                    "Type your question in the input box and press Enter or click Send",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_TITLE": "Features",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_1":
                    "New Thread (+): Click the + icon above to start a fresh conversation",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_2":
                    "Feedback: Use thumbs up/down to rate responses",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_3":
                    "Tool Steps: View agent actions during and after response generation (click to expand)",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_4":
                    "Model Reasoning: Click the 💡 icon to view the model's thinking process (available with reasoning models)",
                "CHATBOT.PLAYGROUND.HELP_FEATURES_5":
                    "Scroll Navigation: Use the ↑ icon to quickly scroll back to your question",
                "CHATBOT.PLAYGROUND.HELP_TIPS_TITLE": "Tips",
                "CHATBOT.PLAYGROUND.HELP_TIPS_1":
                    "Runtime selection is locked once a conversation starts",
                "CHATBOT.PLAYGROUND.HELP_TIPS_2":
                    "Use 'User Sessions' in the sidebar to view past conversations",
                "CHATBOT.PLAYGROUND.HELP_TIPS_3":
                    "Agents may use tools to fetch data, search knowledge bases, or perform actions",
                "CHATBOT.PLAYGROUND.HELP_TIPS_4":
                    "Response execution time is displayed for each AI response",
                "CHATBOT.PLAYGROUND.VIEW_CHUNK_MSG": "View",
                "CHATBOT.PLAYGROUND.LOADING_MSG": "Loading session",
                "CHATBOT.PLAYGROUND.NEW_THREAD_MSG": "New Thread",
                //
                "ADMIN.AGENTCORE.USER_GUIDE_MSG": "AgentCore Manager Guide",
                "ADMIN.AGENTCORE.HELP_OVERVIEW_TITLE": "Overview",
                "ADMIN.AGENTCORE.HELP_OVERVIEW_1":
                    "The AgentCore Manager allows you to create, manage, and deploy AI agent runtimes",
                "ADMIN.AGENTCORE.HELP_OVERVIEW_2":
                    "Each agent can have multiple versions and endpoints (qualifiers) for different deployments",
                "ADMIN.AGENTCORE.HELP_ACTIONS_TITLE": "Actions",
                "ADMIN.AGENTCORE.HELP_ACTIONS_1":
                    "New Agent: Create a new agent runtime from scratch",
                "ADMIN.AGENTCORE.HELP_ACTIONS_2":
                    "New Version: Create a new version based on an existing agent's configuration",
                "ADMIN.AGENTCORE.HELP_ACTIONS_3":
                    "Tag Version: Create a named endpoint (qualifier) pointing to a specific version",
                "ADMIN.AGENTCORE.HELP_ACTIONS_4":
                    "Set as Favorite: Mark an endpoint as the default for quick access in chat",
                "ADMIN.AGENTCORE.HELP_ACTIONS_5":
                    "View: Inspect agent versions, configurations, and assigned qualifiers",
                "ADMIN.AGENTCORE.HELP_ACTIONS_6":
                    "Delete: Remove an entire agent or specific endpoints",
                "ADMIN.AGENTCORE.HELP_TIPS_TITLE": "Tips",
                "ADMIN.AGENTCORE.HELP_TIPS_1":
                    "Qualifiers (endpoints) allow you to maintain multiple deployments (e.g., 'dev', 'prod') of the same agent",
                "ADMIN.AGENTCORE.HELP_TIPS_2":
                    "The ⭐ icon indicates your favorite endpoint, which is pre-selected in the chat interface",
                "ADMIN.AGENTCORE.HELP_TIPS_3":
                    "Use the filter to search agents by name, status, or runtime ID",
                "ADMIN.AGENTCORE.HELP_TIPS_4":
                    "Click on agent names or runtime IDs to copy them to clipboard",
                //
                "COMMON.INFO.GET_STARTED_MSG": "Get started!",
                "COMMON.INFO.DUMMY_MSG": "Lorem Ipsum...",
                "COMMON.INFO.HOME_BUTTON.": "Home",
                "COMMON.INFO.LOADING_MSG": "Loading",
                "COMMON.INFO.CANCEL_BUTTON": "Cancel",
                "COMMON.INFO.APP_DESCRIPTION": "Agentic Chatbot Accelerator...",
                "COMMON.ERRORS.LOAD_ERROR_MSG": "Error loading configuration from",
                "COMMON.ERRORS.NOT_FOUND_MSG": "The page you are looking for does not exist.",
            },
        },
    },
    lng: "en", // default language
    fallbackLng: "en",
    interpolation: {
        escapeValue: false,
    },
});

export default i18n;
