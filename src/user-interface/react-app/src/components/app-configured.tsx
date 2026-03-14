import {
    Authenticator,
    Heading,
    ThemeProvider,
    defaultDarkModeOverride,
    useTheme,
} from "@aws-amplify/ui-react";
import { Amplify } from "aws-amplify";
import { useEffect, useState } from "react";
import App from "../app";

import "@aws-amplify/ui-react/styles.css";
import { Alert, StatusIndicator } from "@cloudscape-design/components";
import { Mode } from "@cloudscape-design/global-styles";
import { useTranslation } from "react-i18next";
import { AppContext } from "../common/app-context";
import { CHATBOT_NAME } from "../common/constants";
import { StorageHelper } from "../common/helpers/storage-helper";
import { AppConfig } from "../common/types";

export default function AppConfigured() {
    const { tokens } = useTheme();
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [error, setError] = useState<boolean | null>(null);
    const [theme, setTheme] = useState(StorageHelper.getTheme());
    const { t } = useTranslation("ACA");

    useEffect(() => {
        (async () => {
            try {
                const result = await fetch("/aws-exports.json");
                const awsExports = await result.json();
                Amplify.configure(awsExports);

                const currentConfig = awsExports;

                setConfig(currentConfig);
            } catch (e) {
                console.error(e);
                setError(true);
            }
        })();
    }, []);

    useEffect(() => {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === "attributes" && mutation.attributeName === "style") {
                    const newValue =
                        document.documentElement.style.getPropertyValue("--app-color-scheme");

                    const mode = newValue === "dark" ? Mode.Dark : Mode.Light;
                    if (mode !== theme) {
                        setTheme(mode);
                    }
                }
            });
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style"],
        });

        return () => {
            observer.disconnect();
        };
    }, [theme]);

    if (!config) {
        if (error) {
            return (
                <div
                    style={{
                        height: "100%",
                        width: "100%",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                    }}
                >
                    <Alert header="Configuration error" type="error">
                        {t("COMMON.ERRORS.LOAD_ERROR_MSG")} "
                        <a href="/aws-exports.json" style={{ fontWeight: "600" }}>
                            /aws-exports.json
                        </a>
                        "
                    </Alert>
                </div>
            );
        }

        return (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                }}
            >
                <StatusIndicator type="loading">{t("COMMON.INFO.LOADING_MSG")}</StatusIndicator>
            </div>
        );
    }

    return (
        <AppContext.Provider value={config}>
            <ThemeProvider
                theme={{
                    name: "default-theme",
                    overrides: [defaultDarkModeOverride],
                }}
                colorMode={theme === Mode.Dark ? "dark" : "light"}
            >
                <Authenticator
                    hideSignUp={true}
                    components={{
                        SignIn: {
                            Header: () => {
                                return (
                                    <Heading
                                        padding={`${tokens.space.xl} 0 0 ${tokens.space.xl}`}
                                        level={3}
                                    >
                                        {CHATBOT_NAME}
                                    </Heading>
                                );
                            },
                        },
                    }}
                >
                    <App />
                </Authenticator>
            </ThemeProvider>
        </AppContext.Provider>
    );
}
