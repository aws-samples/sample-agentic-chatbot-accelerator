export class Utils {
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    /** Message from an Amplify GraphQL error (`{ errors: [...] }`), an Error, or a string. */
    static getErrorMessage(error: any): string {
        if (error?.errors?.length) {
            return error.errors.map((e: any) => e.message).join(", ");
        }
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string" && error) return error;
        return "Unknown error";
    }
    /* eslint-enable  @typescript-eslint/no-explicit-any */
}

/**
 * Resolve the concrete runtime version for a selected endpoint (qualifier).
 *
 * `listRuntimeAgents` returns `qualifierToVersion` as a JSON string mapping each
 * endpoint name to its numeric AgentCore version. The container persists this
 * value to session history so the Sessions table can show which version served
 * a conversation. Returns "" when the map is missing/unparseable or the
 * qualifier has no entry, matching the read-side fallback.
 */
export function resolveRuntimeVersion(
    qualifierToVersion: string | null | undefined,
    qualifier: string,
): string {
    const version = parseQualifierMap(qualifierToVersion)[qualifier];
    return version === undefined || version === null ? "" : String(version);
}

/** Parse a `qualifierToVersion` JSON string; `{}` when missing or malformed. */
export function parseQualifierMap(
    qualifierToVersion: string | null | undefined,
): Record<string, number | string> {
    if (!qualifierToVersion) return {};
    try {
        const parsed = JSON.parse(qualifierToVersion);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** Endpoint select options for an agent, always including DEFAULT first if absent. */
export function getEndpointOptions(
    agent: { qualifierToVersion?: string | null } | undefined,
): { label: string; value: string }[] {
    const options = Object.keys(parseQualifierMap(agent?.qualifierToVersion)).map((key) => ({
        label: key,
        value: key,
    }));
    if (!options.some((o) => o.value === "DEFAULT")) {
        options.unshift({ label: "DEFAULT", value: "DEFAULT" });
    }
    return options;
}
