import { branchSource } from "./branch";
import type { ContextSource } from "../types";

/**
 * Registry of all available context sources for the @ picker.
 * Add new sources here to include them in the unified fuzzy search.
 */
export const CONTEXT_SOURCES: ContextSource[] = [
  branchSource,
  // future: prSource, issueSource, fileSource, ...
];
