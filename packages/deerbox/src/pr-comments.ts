/**
 * Fetch and format PR review comments for injection into Claude's prompt context.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface PRReviewComment {
  /** Comment ID — used to map to thread resolution status */
  id?: number;
  user: { login: string };
  body: string;
  /** File path for inline diff comments */
  path?: string;
  /** Line number for inline diff comments */
  line?: number;
  /** Diff position; null when the comment is on an outdated hunk */
  position?: number | null;
}

export interface PRIssueComment {
  user: { login: string };
  body: string;
}

/**
 * Runs a `gh api <endpoint>` call and returns stdout + exit code.
 * Injectable for testing.
 */
export type GhApiRunner = (endpoint: string) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Runs a `gh api graphql` call and returns stdout + exit code.
 * Injectable for testing.
 */
export type GhGraphqlRunner = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<{ stdout: string; exitCode: number }>;

/** Per-thread resolution/outdated status keyed by comment database ID. */
export type ThreadStatusMap = Map<number, { isResolved: boolean; isOutdated: boolean }>;

export interface FetchPRCommentsResult {
  /** Formatted context block for Claude's system prompt, or null if there are no comments. */
  formatted: string | null;
  /** Number of non-empty inline review comments fetched. */
  reviewCount: number;
  /** Number of non-empty issue-level discussion comments fetched. */
  issueCount: number;
}

// ── Pure formatting ───────────────────────────────────────────────────

/**
 * Format fetched PR comments into a context block for Claude.
 * Returns null if there are no non-empty comments.
 *
 * When `threadStatus` is provided, comments belonging to resolved or outdated
 * threads are annotated so the AI knows not to re-address them.
 * Falls back to `position === null` to detect outdated comments without GraphQL.
 */
export function formatPRComments(
  reviewComments: PRReviewComment[],
  issueComments: PRIssueComment[],
  threadStatus?: ThreadStatusMap,
): string | null {
  const lines: string[] = [];

  for (const c of reviewComments) {
    const body = c.body.trim();
    if (!body) continue;

    const status = c.id != null ? threadStatus?.get(c.id) : undefined;
    const isResolved = status?.isResolved ?? false;
    const isOutdated = status?.isOutdated ?? (c.position === null && c.position !== undefined);

    const location = c.path
      ? c.line != null
        ? `on ${c.path} line ${c.line}`
        : `on ${c.path}`
      : null;

    const statusLabel = isResolved ? " — RESOLVED" : isOutdated ? " — OUTDATED" : "";

    const header = location
      ? `[Review by @${c.user.login} ${location}${statusLabel}]`
      : `[Review by @${c.user.login}${statusLabel}]`;
    lines.push(header, body, "");
  }

  for (const c of issueComments) {
    const body = c.body.trim();
    if (!body) continue;
    lines.push(`[Comment by @${c.user.login}]`, body, "");
  }

  if (lines.length === 0) return null;

  // Remove trailing blank line
  while (lines.at(-1) === "") lines.pop();

  return `PR Review Comments:\n\n${lines.join("\n")}`;
}

// ── Fetching ──────────────────────────────────────────────────────────

function parsePRUrl(prUrl: string): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

const defaultRunner: GhApiRunner = async (endpoint) => {
  const result = await Bun.$`gh api ${endpoint}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

const defaultGraphqlRunner: GhGraphqlRunner = async (query, variables) => {
  const varArgs = Object.entries(variables).flatMap(([k, v]) => ["-F", `${k}=${v}`]);
  const result = await Bun.$`gh api graphql -f query=${query} ${varArgs}`.quiet().nothrow();
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
};

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            comments(first: 100) {
              nodes { databaseId }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch review thread resolution/outdated status via GraphQL.
 * Returns a map of comment database ID → thread status.
 * Returns an empty map if GraphQL is unavailable or the query fails.
 */
async function fetchReviewThreadStatus(
  owner: string,
  repo: string,
  number: number,
  runner: GhGraphqlRunner,
): Promise<ThreadStatusMap> {
  const map: ThreadStatusMap = new Map();
  try {
    const result = await runner(REVIEW_THREADS_QUERY, { owner, repo, number });
    if (result.exitCode !== 0) return map;
    const data = JSON.parse(result.stdout) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                isResolved: boolean;
                isOutdated: boolean;
                comments: { nodes: Array<{ databaseId: number }> };
              }>;
            };
          };
        };
      };
    };
    for (const thread of data.data.repository.pullRequest.reviewThreads.nodes) {
      const status = { isResolved: thread.isResolved, isOutdated: thread.isOutdated };
      for (const comment of thread.comments.nodes) {
        map.set(comment.databaseId, status);
      }
    }
  } catch {
    // Graceful degradation — fall back to REST-derived outdated detection
  }
  return map;
}

/**
 * Fetch PR review and issue comments from GitHub and return a formatted
 * context block plus counts of non-empty comments fetched.
 *
 * Thread resolution status is fetched via GraphQL and used to annotate
 * comments as RESOLVED or OUTDATED so the AI knows not to re-address them.
 */
export async function fetchPRComments(
  prUrl: string,
  runner: GhApiRunner = defaultRunner,
  graphqlRunner: GhGraphqlRunner = defaultGraphqlRunner,
): Promise<FetchPRCommentsResult> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) return { formatted: null, reviewCount: 0, issueCount: 0 };

  const { owner, repo, number } = parsed;

  let reviewComments: PRReviewComment[] = [];
  let issueComments: PRIssueComment[] = [];

  try {
    const [reviewRes, issueRes] = await Promise.all([
      runner(`/repos/${owner}/${repo}/pulls/${number}/comments`),
      runner(`/repos/${owner}/${repo}/issues/${number}/comments`),
    ]);

    if (reviewRes.exitCode === 0) {
      reviewComments = JSON.parse(reviewRes.stdout) as PRReviewComment[];
    }
    if (issueRes.exitCode === 0) {
      issueComments = JSON.parse(issueRes.stdout) as PRIssueComment[];
    }
  } catch {
    return { formatted: null, reviewCount: 0, issueCount: 0 };
  }

  const threadStatus = await fetchReviewThreadStatus(owner, repo, parseInt(number), graphqlRunner);

  const reviewCount = reviewComments.filter((c) => c.body.trim()).length;
  const issueCount = issueComments.filter((c) => c.body.trim()).length;

  return {
    formatted: formatPRComments(reviewComments, issueComments, threadStatus),
    reviewCount,
    issueCount,
  };
}
