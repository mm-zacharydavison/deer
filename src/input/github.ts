export interface GitHubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubIssueData {
  title: string;
  body: string;
  comments: Array<{ author: string; body: string }>;
}

/**
 * Parse a GitHub issue URL into owner/repo/number.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parseGitHubIssueUrl(url: string): GitHubIssueRef | null {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

/**
 * Format a GitHub issue into markdown for use as a task instruction.
 */
export function formatGitHubIssue(data: GitHubIssueData): string {
  let md = `## ${data.title}\n`;

  if (data.body) {
    md += `\n${data.body}\n`;
  }

  if (data.comments.length > 0) {
    md += `\n### Comments\n`;
    for (const comment of data.comments) {
      md += `\n**${comment.author}:**\n${comment.body}\n`;
    }
  }

  return md;
}

/**
 * Fetch a GitHub issue using the `gh` CLI and format it as markdown.
 */
export async function fetchGitHubIssue(url: string): Promise<string> {
  const ref = parseGitHubIssueUrl(url);
  if (!ref) {
    throw new Error(`Not a valid GitHub issue URL: ${url}`);
  }

  const repoSlug = `${ref.owner}/${ref.repo}`;
  const result =
    await Bun.$`gh issue view ${ref.number} --repo ${repoSlug} --json title,body,comments`.quiet();

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fetch GitHub issue: gh exited with code ${result.exitCode}\n${result.stderr.toString()}`
    );
  }

  const json = JSON.parse(result.stdout.toString()) as {
    title: string;
    body: string;
    comments: Array<{ author: { login: string }; body: string }>;
  };

  return formatGitHubIssue({
    title: json.title,
    body: json.body,
    comments: json.comments.map((c) => ({
      author: c.author.login,
      body: c.body,
    })),
  });
}
