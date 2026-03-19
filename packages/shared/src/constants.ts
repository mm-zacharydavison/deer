/** HOME directory fallback */
export const HOME = process.env.HOME ?? "/root";

/** Default Claude model to use */
export const DEFAULT_MODEL = "sonnet";

/** Max number of polls to wait for the bypass permissions dialog */
export const BYPASS_DIALOG_MAX_POLLS = 15;

/** Delay between polls when looking for the bypass dialog */
export const BYPASS_DIALOG_POLL_MS = 500;

/** Delay between keystrokes when dismissing the bypass dialog */
export const BYPASS_DIALOG_KEY_DELAY_MS = 200;

/** Max diff length sent to Claude for PR metadata generation */
export const MAX_DIFF_FOR_PR_METADATA = 20_000;

/** Model used to generate PR metadata (title, body, branch name) */
export const PR_METADATA_MODEL = "sonnet";
