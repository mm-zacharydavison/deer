import { fetchGitHubIssue, parseGitHubIssueUrl } from "./github";
import { fetchWebPage } from "./web";

export type InputType =
  | { kind: "url"; url: string; domain: string }
  | { kind: "file"; path: string }
  | { kind: "text"; text: string };

/**
 * Detect the type of task input.
 *
 * 1. Starts with http:// or https:// → url (extract domain)
 * 2. Ends with .md or .txt and file exists → file
 * 3. Otherwise → raw text
 */
export async function detectInputType(input: string): Promise<InputType> {
  // Check for URLs first
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    return { kind: "url", url: input, domain: url.hostname };
  }

  // Check for file paths ending with .md or .txt
  if (/\.(md|txt)$/.test(input)) {
    const file = Bun.file(input);
    if (await file.exists()) {
      return { kind: "file", path: input };
    }
  }

  // Default to raw text
  return { kind: "text", text: input };
}

/**
 * Resolve task input into a full instruction string and its source.
 *
 * - URLs: fetches content (GitHub issues via `gh`, other URLs via fetch)
 * - Files: reads file content
 * - Text: uses as-is
 */
export async function resolveInstruction(
  input: string
): Promise<{ instruction: string; source: string }> {
  const detected = await detectInputType(input);

  switch (detected.kind) {
    case "url": {
      const ghIssue = parseGitHubIssueUrl(detected.url);
      if (ghIssue) {
        return {
          instruction: await fetchGitHubIssue(detected.url),
          source: detected.url,
        };
      }
      return {
        instruction: await fetchWebPage(detected.url),
        source: detected.url,
      };
    }
    case "file":
      return {
        instruction: await Bun.file(detected.path).text(),
        source: detected.path,
      };
    case "text":
      return { instruction: detected.text, source: "inline" };
  }
}
