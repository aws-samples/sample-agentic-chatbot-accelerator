/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
File:
    React component written for a global header UI element
*/
import { ButtonDropdownProps, TopNavigation } from "@cloudscape-design/components";
import { Mode } from "@cloudscape-design/global-styles";
import { fetchUserAttributes, getCurrentUser, signOut } from "aws-amplify/auth";
import { useEffect, useState } from "react";
import { CHATBOT_NAME } from "../common/constants";
import { StorageHelper } from "../common/helpers/storage-helper";
import useOnFollow from "../common/hooks/use-on-follow";

export default function GlobalHeader() {
    const onFollow = useOnFollow();
    const [userName, setUserName] = useState<string | null>(null);
    const [theme, setTheme] = useState<Mode>(StorageHelper.getTheme()); // light/dark mode

    // Use hook to fetch the current's user information with Amplify
    useEffect(() => {
        (async () => {
            const result = await getCurrentUser();

            if (!result || Object.keys(result).length === 0) {
                signOut();
                return;
            }
            const attributes = await fetchUserAttributes();
            const email = attributes.email!;
            const givenName = attributes.given_name ?? "";
            const familyName = attributes.family_name ?? "";

            // Display full name in dropdown, fallback to email if names not set
            const displayName =
                givenName || familyName ? `${givenName} ${familyName}`.trim() : email;
            setUserName(displayName);

            // Use given name for tooltips/chat, fallback to email prefix
            const shortName = givenName || email.split("@")[0];

            // Initials: first letter of given + family name, fallback to email prefix
            const initials =
                givenName && familyName
                    ? `${givenName.charAt(0)}${familyName.charAt(0)}`.toUpperCase()
                    : email.substring(0, 2).toUpperCase();

            StorageHelper.setUserId(result.username);
            StorageHelper.setUserName(shortName);
            StorageHelper.setUserInitials(initials);
        })();
    }, []);

    // theme management
    const onChangeThemeClick = () => {
        if (theme === Mode.Dark) {
            setTheme(StorageHelper.applyTheme(Mode.Light));
        } else {
            setTheme(StorageHelper.applyTheme(Mode.Dark));
        }
    };

    // user profile dropdown
    const onUserProfileClick = ({ detail }: { detail: ButtonDropdownProps.ItemClickDetails }) => {
        if (detail.id === "signout") {
            StorageHelper.setUserName("");
            StorageHelper.setUserInitials("XX");
            signOut();
        }
    };

    // Rendering - refer to https://cloudscape.design/components/top-navigation/
    return (
        <div
            style={{
                zIndex: 1002,
                top: 0,
                left: 0,
                right: 0,
                position: "fixed",
            }}
            id="awsui-top-navigation"
        >
            <TopNavigation
                identity={{
                    href: "/",
                    logo: {
                        src: "/images/logo.png",
                        alt: { CHATBOT_NAME } + " Logo ",
                    },
                }}
                utilities={[
                    {
                        type: "button",
                        text: theme === Mode.Dark ? "Light Mode" : "Dark Mode",
                        onClick: onChangeThemeClick,
                    },
                    {
                        type: "menu-dropdown",
                        description: userName ?? "",
                        iconName: "user-profile",
                        onItemClick: onUserProfileClick,
                        items: [
                            {
                                id: "signout",
                                text: "Sign out",
                            },
                        ],
                        onItemFollow: onFollow,
                    },
                ]}
            />
        </div>
    );
}
