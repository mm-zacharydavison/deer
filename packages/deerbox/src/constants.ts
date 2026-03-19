import pkg from "../package.json";

/** Package version, inlined at build time */
export const VERSION = pkg.version;

export { HOME, DEFAULT_MODEL, BYPASS_DIALOG_MAX_POLLS, BYPASS_DIALOG_POLL_MS, BYPASS_DIALOG_KEY_DELAY_MS, MAX_DIFF_FOR_PR_METADATA, PR_METADATA_MODEL } from "@deer/shared";
