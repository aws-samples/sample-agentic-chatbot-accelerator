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
