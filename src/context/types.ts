// ── Context system types ──────────────────────────────────────────────
//
// The @ context picker fans out to all registered ContextSources,
// merges their results, and lets the user fuzzy-search across all of
// them in one step. Selecting an item produces a ContextChip that sits
// above the prompt input and is resolved to agent run parameters at
// submit time.

export interface ContextSourceItem {
  id: string;
  /** Primary display text shown in the picker list */
  label: string;
  /** Optional secondary info shown dimmed beside the label (e.g. last commit) */
  sublabel?: string;
}

export interface ContextSource {
  /** Unique type key, e.g. "branch", "pr", "issue" */
  type: string;
  /** Short name for display, e.g. "Branch", "Pull Request" */
  label: string;
  /**
   * Icon prefix shown in picker rows and chips.
   * @example "⎇"
   */
  icon: string;
  /**
   * Fetch items matching `query` from this source.
   * An empty query should return a sensible default set (e.g. all local branches).
   *
   * @param query - The user's current search string
   * @param repoPath - Absolute path to the git repository root
   */
  search(query: string, repoPath: string): Promise<ContextSourceItem[]>;
  /** Convert a selected picker item into a chip */
  toChip(item: ContextSourceItem): ContextChip;
}

/**
 * A resolved context chip displayed above the prompt input.
 * Add new members to this union to support additional context types.
 */
export type ContextChip =
  | { type: "branch"; label: string; value: string };
  // future:
  // | { type: "pr";    label: string; value: string; url: string }
  // | { type: "issue"; label: string; value: string; url: string }
