import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

/**
 * Execute a function while holding an exclusive lock on `.git/deer.lock`.
 * Prevents concurrent deer processes from corrupting git state.
 *
 * Uses mkdir atomicity: `mkdir` with `{ recursive: false }` fails if the
 * directory already exists, providing a cross-process lock primitive.
 */
export async function withGitLock<T>(
  repoPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = join(repoPath, ".git", "deer.lock");

  // Spin until we acquire the lock
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      break; // Lock acquired
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        // Lock held by another process, wait and retry
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    // Release lock
    await rm(lockPath, { recursive: true, force: true });
  }
}
