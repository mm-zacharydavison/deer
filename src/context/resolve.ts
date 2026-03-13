import type { ContextChip } from "./types";

/**
 * Translate a set of context chips into agent run option overrides.
 * Each chip type maps to a specific field — unrecognised types are ignored.
 */
export function resolveChips(chips: ContextChip[]): { baseBranch?: string } {
  const branch = chips.find((c) => c.type === "branch");
  return {
    baseBranch: branch?.value,
    // future: pr/issue chips → inject context into system prompt, etc.
  };
}
