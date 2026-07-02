export class Utils {
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    static getErrorMessage(error: any) {
        if (error.errors) {
            return error.errors.map((e: any) => e.message).join(", ");
        }

        return "Unknown error";
    }
    /* eslint-enable  @typescript-eslint/no-explicit-any */

    static isFunction(value: unknown): value is Function {
        return typeof value === "function";
    }
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
    if (!qualifierToVersion) return "";
    try {
        const version = (JSON.parse(qualifierToVersion) as Record<string, number | string>)[qualifier];
        return version === undefined || version === null ? "" : String(version);
    } catch {
        return "";
    }
}
