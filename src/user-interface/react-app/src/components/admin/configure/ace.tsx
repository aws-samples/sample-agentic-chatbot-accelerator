// -------------------------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
//
// Sets up and configures the Ace code editor, which is a popular web-based code editor
// -------------------------------------------------------------------------------------
import ace from "ace-builds";

// // Import required modules
import "ace-builds/src-noconflict/ext-language_tools";
import "ace-builds/src-noconflict/ext-searchbox";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/theme-cloud_editor";
import "ace-builds/src-noconflict/theme-cloud_editor_dark";

import jsonWorkerUrl from "ace-builds/src-noconflict/worker-json?url";

let acePromise: Promise<any> | null = null;

export const aceLoader = {
    load: (): Promise<any> => {
        if (!acePromise) {
            acePromise = Promise.resolve(ace);

            ace.config.setModuleUrl("ace/mode/json_worker", jsonWorkerUrl);
            ace.require("ace/config").setDefaultValue("session", "useWorker", true);
        }
        return acePromise;
    },
};
