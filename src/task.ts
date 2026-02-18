export interface Task {
  /** @example "deer_01jm8k3nxa7f" */
  id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  /** @example "/home/user/repos/my-project" */
  repo: string;
  /** @example "github.com/org/repo" */
  repoRemote: string;
  /** @example "main" */
  baseBranch: string;
  /** @example "deer/deer_01jm8k3n" */
  workBranch: string;
  /** @example "~/.local/share/deer/tasks/deer_01jm8k3n/worktree" */
  worktreePath: string;
  /** Full task markdown */
  instruction: string;
  /** @example "https://github.com/org/repo/issues/42" */
  instructionSource: string;
  env: Record<string, string>;
  networkAllowlist: string[];
  /**
   * @default 1800000 (30 minutes)
   */
  timeoutMs: number;
  setupCommand?: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  prUrl: string | null;
  error: string | null;
}

/**
 * Generate a unique, sortable, URL-safe task ID.
 *
 * Format: `deer_<base36-timestamp><random-suffix>`
 * - Timestamp prefix makes IDs sortable by creation time
 * - Random suffix ensures uniqueness across concurrent invocations
 * - All characters are URL-safe (lowercase alphanumeric + underscore prefix)
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(random)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  return `deer_${timestamp}${suffix}`;
}

/**
 * Returns the base data directory for deer task storage.
 * @example "/home/user/.local/share/deer"
 */
export function dataDir(): string {
  const home = process.env.HOME;
  return `${home}/.local/share/deer`;
}
